import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	decryptSecretValue,
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	decryptWebhookHmacSecret,
	decryptWebhookUrlSecret,
	encryptSecretValue,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	encryptWebhookHmacSecret,
	encryptWebhookUrlSecret,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
	userSecretContext,
	userWebhookHmacSecretContext,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import {
	readVaultItemConfig,
	vaultItemRefContext,
} from '#mcp/secrets/vault-item-config.ts'
import type { OrgTransferPlan } from './plan.ts'
import type { OrgTransferRow } from './snapshot.ts'

type CryptoEnv = Pick<Env, 'SECRET_STORE_KEY'>
type Seal = (env: CryptoEnv, value: string, context: string) => Promise<string>

type SealedColumn = {
	column: string
	decrypt: Seal
	encrypt: Seal
} & (
	| {
			context: (ownerId: OwnerId, row: OrgTransferRow) => string
			nested?: never
	  }
	| {
			nested: (raw: string) => {
				ciphertext: string
				context: (ownerId: OwnerId) => string
				replace: (ciphertext: string) => string
			} | null
	  }
)

/** Re-sealed ciphertext columns per moved row, keyed `table:rowid`. */
export type OrgTransferSealedColumns = Map<string, Record<string, string>>

export function sealedRowKey(table: string, rowid: number) {
	return `${table}:${rowid}`
}

const text = (row: OrgTransferRow, column: string) => String(row[column] ?? '')

/** Every ciphertext column whose AAD context names the owner. */
export const orgTransferSealedColumns = {
	secret_entries: [
		{
			column: 'encrypted_value',
			decrypt: decryptSecretValue,
			encrypt: encryptSecretValue,
			context: (ownerId) => userSecretContext(ownerId),
		},
		{
			column: 'config_json',
			decrypt: decryptSecretValue,
			encrypt: encryptSecretValue,
			nested: (raw) => {
				const config = readVaultItemConfig(raw)
				return config
					? {
							ciphertext: config.encryptedRef,
							context: (ownerId) =>
								vaultItemRefContext(ownerId, config.bindingId),
							replace: (encryptedRef) =>
								JSON.stringify({ ...config, encryptedRef }),
						}
					: null
			},
		},
	],
	user_integrations: [
		{
			column: 'access_token_encrypted',
			decrypt: decryptUserOauthAccessToken,
			encrypt: encryptUserOauthAccessToken,
			context: (ownerId, row) =>
				userIntegrationCredentialContext(ownerId, text(row, 'name')),
		},
		{
			column: 'refresh_token_encrypted',
			decrypt: decryptUserOauthRefreshToken,
			encrypt: encryptUserOauthRefreshToken,
			context: (ownerId, row) =>
				userIntegrationCredentialContext(ownerId, text(row, 'name')),
		},
	],
	user_oauth_apps: [
		{
			column: 'client_secret_encrypted',
			decrypt: decryptUserOauthClientSecret,
			encrypt: encryptUserOauthClientSecret,
			context: (ownerId, row) =>
				userOauthAppCredentialContext(ownerId, text(row, 'slug')),
		},
	],
	webhook_endpoints: [
		{
			column: 'url_secret_encrypted',
			decrypt: decryptWebhookUrlSecret,
			encrypt: encryptWebhookUrlSecret,
			context: (ownerId, row) =>
				userWebhookUrlSecretContext(ownerId, text(row, 'id')),
		},
		{
			column: 'hmac_secret_encrypted',
			decrypt: decryptWebhookHmacSecret,
			encrypt: encryptWebhookHmacSecret,
			context: (ownerId, row) =>
				userWebhookHmacSecretContext(ownerId, text(row, 'id')),
		},
		{
			column: 'hmac_verification_secret_encrypted',
			decrypt: decryptWebhookHmacSecret,
			encrypt: encryptWebhookHmacSecret,
			context: (ownerId, row) =>
				userWebhookHmacSecretContext(ownerId, text(row, 'id')),
		},
		{
			column: 'previous_hmac_secret_encrypted',
			decrypt: decryptWebhookHmacSecret,
			encrypt: encryptWebhookHmacSecret,
			context: (ownerId, row) =>
				userWebhookHmacSecretContext(ownerId, text(row, 'id')),
		},
	],
} satisfies Record<string, ReadonlyArray<SealedColumn>>

export type OrgTransferSealedTable = keyof typeof orgTransferSealedColumns

function rowLabel(table: OrgTransferSealedTable, row: OrgTransferRow) {
	switch (table) {
		case 'secret_entries':
			return `secret ${text(row, 'name')}`
		case 'user_integrations':
			return `integration ${text(row, 'name')}`
		case 'user_oauth_apps':
			return `OAuth app ${text(row, 'slug')}`
		case 'webhook_endpoints':
			return `webhook ${text(row, 'webhook_name')}`
		default: {
			const unhandled: never = table
			return unhandled
		}
	}
}

/**
 * Re-seal every moved ciphertext from the source owner's key context to the
 * target's, and prove each new ciphertext opens under the target context
 * before anything commits. Plaintext lives only inside this function: it is
 * never returned, logged, or put in an error message.
 */
export async function resealOrgTransferSecrets(input: {
	env: CryptoEnv
	plan: OrgTransferPlan
}): Promise<OrgTransferSealedColumns> {
	const sealed: OrgTransferSealedColumns = new Map()
	const { from, to } = input.plan
	for (const table of Object.keys(
		orgTransferSealedColumns,
	) as Array<OrgTransferSealedTable>) {
		const columns: ReadonlyArray<SealedColumn> = orgTransferSealedColumns[table]
		for (const row of input.plan.moves[table]) {
			const next: Record<string, string> = {}
			for (const spec of columns) {
				const raw = row[spec.column]
				if (typeof raw !== 'string' || raw.length === 0) continue
				const field = spec.nested
					? spec.nested(raw)
					: {
							ciphertext: raw,
							context: (ownerId: OwnerId) => spec.context(ownerId, row),
							replace: (ciphertext: string) => ciphertext,
						}
				if (!field) continue
				const failure = `Could not re-seal ${spec.column} for ${rowLabel(table, row)}.`
				let matches = false
				let ciphertext = ''
				try {
					const plaintext = await spec.decrypt(
						input.env,
						field.ciphertext,
						field.context(from.id),
					)
					ciphertext = await spec.encrypt(
						input.env,
						plaintext,
						field.context(to.id),
					)
					matches =
						(await spec.decrypt(
							input.env,
							ciphertext,
							field.context(to.id),
						)) === plaintext
				} catch {
					throw new Error(failure)
				}
				if (!matches) throw new Error(failure)
				next[spec.column] = field.replace(ciphertext)
			}
			if (Object.keys(next).length > 0) {
				sealed.set(sealedRowKey(table, row.__rowid), next)
			}
		}
	}
	return sealed
}
