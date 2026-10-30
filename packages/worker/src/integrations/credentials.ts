import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	decryptUserOauthAccessToken,
	decryptUserOauthClientSecret,
	decryptUserOauthRefreshToken,
	encryptUserOauthAccessToken,
	encryptUserOauthClientSecret,
	encryptUserOauthRefreshToken,
	userIntegrationCredentialContext,
	userOauthAppCredentialContext,
} from '#mcp/secrets/crypto.ts'
import {
	getIntegrationCredentialCiphertexts,
	getIntegrationCredentialId,
	getOauthAppClientSecretCiphertext,
	clearIntegrationAuthFailure,
	getIntegrationRefreshTokenCiphertextForLease,
	updateIntegrationCredentialCiphertexts,
	updateOauthAppClientSecretCiphertext,
} from './repo.ts'
import { type IntegrationRefreshPolicy } from './refresh-policy.ts'
import {
	credentialAuditActions,
	recordCredentialAudit,
} from '#worker/credentials/credential-audit.ts'
import { type OrgAuditWriter } from '#worker/orgs/org-audit.ts'

type CredentialEnv = Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>

export function createMissingIntegrationAccessTokenMessage(name: string) {
	return `Integration "${name}" does not have a stored access token.`
}

export async function persistIntegrationTokens(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
	accessToken: string
	refreshToken?: string | null
	/**
	 * Overwrites the stored policy. `/connect/oauth` passes
	 * `inferIntegrationRefreshPolicy(tokenPayload)` so a reconnect re-decides
	 * it; a successful refresh passes `required`.
	 */
	refreshPolicy: IntegrationRefreshPolicy
	/**
	 * Host-side refresh passes its lease so a holder whose lease expired cannot
	 * overwrite tokens a newer refresher already rotated.
	 */
	refreshLeaseId?: string
	/**
	 * Person-initiated connects pass the org audit writer so a reconnect over
	 * an existing token audits as a replaced value. Host-side refresh passes
	 * null: a refresh is not an org change.
	 */
	audit: OrgAuditWriter | null
}): Promise<void> {
	const previous = input.audit
		? await getIntegrationCredentialCiphertexts({
				db: input.env.APP_DB,
				userId: input.userId,
				name: input.name,
			})
		: null
	const context = userIntegrationCredentialContext(input.userId, input.name)
	const accessTokenEncrypted = await encryptUserOauthAccessToken(
		input.env,
		input.accessToken,
		context,
	)
	const refreshToken = input.refreshToken?.trim() || null
	const refreshTokenEncrypted = refreshToken
		? await encryptUserOauthRefreshToken(input.env, refreshToken, context)
		: null
	const { written } = await updateIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
		accessTokenEncrypted,
		refreshTokenEncrypted,
		refreshPolicy: input.refreshPolicy,
		...(input.refreshLeaseId === undefined
			? {}
			: { refreshLeaseId: input.refreshLeaseId }),
	})
	if (input.refreshLeaseId !== undefined && !written) {
		throw new Error(
			`Token refresh lease for integration "${input.name}" expired before its tokens were saved.`,
		)
	}
	if (previous?.accessTokenEncrypted) {
		await recordCredentialAudit(input.audit, {
			orgId: input.userId,
			credential: {
				id: previous.credentialId,
				kind: 'integration',
				name: input.name,
			},
			action: credentialAuditActions.valueReplaced,
			details: { fields: ['value'] },
		})
	}
	try {
		await clearIntegrationAuthFailure({
			db: input.env.APP_DB,
			userId: input.userId,
			name: input.name,
		})
	} catch {
		// Clearing last-failure is best-effort; token persist must still succeed.
	}
}

export async function persistUserOauthAppClientSecret(input: {
	env: CredentialEnv
	userId: OwnerId
	slug: string
	value: string
}): Promise<void> {
	const encrypted = await encryptUserOauthClientSecret(
		input.env,
		input.value,
		userOauthAppCredentialContext(input.userId, input.slug),
	)
	await updateOauthAppClientSecretCiphertext({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.slug,
		clientSecretEncrypted: encrypted,
	})
}

export type IntegrationAccessToken = {
	/** Credential id of the connection row the token was read from. */
	credentialId: string
	accessToken: string | null
}

/** Null when no connection has this name. */
export async function resolveIntegrationAccessToken(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
}): Promise<IntegrationAccessToken | null> {
	const ciphertexts = await getIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (!ciphertexts) return null
	return {
		credentialId: ciphertexts.credentialId,
		accessToken: ciphertexts.accessTokenEncrypted
			? await decryptUserOauthAccessToken(
					input.env,
					ciphertexts.accessTokenEncrypted,
					userIntegrationCredentialContext(input.userId, input.name),
				)
			: null,
	}
}

/** The connection's credential id, without reading its tokens. */
export async function findIntegrationCredentialId(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	name: string
}): Promise<string | null> {
	return await getIntegrationCredentialId({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
}

export async function resolveIntegrationRefreshToken(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
}): Promise<string | null> {
	const ciphertexts = await getIntegrationCredentialCiphertexts({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (!ciphertexts?.refreshTokenEncrypted) return null
	return decryptUserOauthRefreshToken(
		input.env,
		ciphertexts.refreshTokenEncrypted,
		userIntegrationCredentialContext(input.userId, input.name),
	)
}

export async function resolveIntegrationRefreshTokenForLease(input: {
	env: CredentialEnv
	userId: OwnerId
	name: string
	leaseId: string
	accessTokenEncrypted: string | null
}): Promise<
	| { held: true; refreshToken: string | null }
	| { held: false; savedAt: string | null }
> {
	const read = await getIntegrationRefreshTokenCiphertextForLease({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
		leaseId: input.leaseId,
		accessTokenEncrypted: input.accessTokenEncrypted,
	})
	if (!read.held) return read
	if (!read.refreshTokenEncrypted) return { held: true, refreshToken: null }
	return {
		held: true,
		refreshToken: await decryptUserOauthRefreshToken(
			input.env,
			read.refreshTokenEncrypted,
			userIntegrationCredentialContext(input.userId, input.name),
		),
	}
}

export async function resolveUserOauthAppClientSecret(input: {
	env: CredentialEnv
	userId: OwnerId
	slug: string
}): Promise<string | null> {
	const encrypted = await getOauthAppClientSecretCiphertext({
		db: input.env.APP_DB,
		userId: input.userId,
		slug: input.slug,
	})
	if (!encrypted) return null
	return decryptUserOauthClientSecret(
		input.env,
		encrypted,
		userOauthAppCredentialContext(input.userId, input.slug),
	)
}
