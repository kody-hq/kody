import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	decryptWebhookHmacSecret,
	encryptSecretValue,
	encryptWebhookHmacSecret,
	userSecretContext,
	userWebhookHmacSecretContext,
} from '#mcp/secrets/crypto.ts'
import { upsertSecretBucket, upsertSecretEntry } from '#mcp/secrets/repo.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	encryptWebhookVerificationSnapshot,
	rotateWebhookHmacSecretsForSecretValueChange,
} from './hmac-rotation.ts'
import {
	getWebhookEndpointByIdForUser,
	setWebhookEndpointHmacVerificationState,
	upsertWebhookEndpointSecret,
} from './repo.ts'
import {
	resolveHmacCiphertextForMint,
	resolveWebhookHmacSigningSecret,
	resolveWebhookHmacVerificationSecrets,
} from './signing-secret.ts'
import { type WebhookEndpointRecord } from './types.ts'

async function resolveSecrets(
	...args: Parameters<typeof resolveWebhookHmacVerificationSecrets>
) {
	return (await resolveWebhookHmacVerificationSecrets(...args)).secrets
}

vi.mock('#worker/credentials/self-published-package-guard.ts', () => ({
	assertSelfPublishedPackageResolvesNothing: async () => {},
}))

vi.mock('#mcp/secrets/service.ts', () => {
	const resolveSecret = vi.fn(async (_input: unknown) => ({
		found: true,
		credentialId: 'cred-legacy-webhook-secret',
		value: 'legacy-secret-store-value',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		placement: null,
		scope: 'user',
	}))
	return {
		resolveSecret,
		findSecretForUse: vi.fn(async (input: unknown) => {
			const resolved = await resolveSecret(input)
			const { value: _value, ...found } = resolved
			return { found, readValue: async () => resolved }
		}),
	}
})

const { resolveSecret, findSecretForUse } =
	await import('#mcp/secrets/service.ts')

function endpoint(
	overrides: Partial<WebhookEndpointRecord> = {},
): WebhookEndpointRecord {
	return {
		id: 'ep-1',
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		webhookName: 'github',
		urlSecretHash: 'hash',
		urlSecretEncrypted: 'url-cipher',
		hmacSecretEncrypted: null,
		hmacSecretName: null,
		hmacVerificationSecretEncrypted: null,
		previousUrlSecretHash: null,
		previousUrlSecretExpiresAt: null,
		previousHmacSecretName: null,
		previousHmacSecretEncrypted: null,
		previousHmacSecretExpiresAt: null,
		enabled: true,
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T00:00:00.000Z',
		instanceLabel: null,
		...overrides,
	}
}

const env = {
	APP_DB: {} as D1Database,
	SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	// Opt out of credential-resolution audit writes (#3456).
	SENTRY_ENVIRONMENT: 'test',
} as unknown as Env

const stripeVerification = {
	type: 'hmac-sha256',
	header: 'stripe-signature',
	encoding: 'hex',
	secretName: 'stripeWebhookSecretCancelFarewell',
} as const

async function storedCiphertext(plaintext: string) {
	return encryptWebhookHmacSecret(
		env,
		plaintext,
		userWebhookHmacSecretContext(ownerIdFromStored('user-1'), 'ep-1'),
	)
}

test('apply injects the package-owned ciphertext and never looks up secretName live', async () => {
	vi.mocked(resolveSecret).mockClear()
	const value = await resolveWebhookHmacSigningSecret({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: endpoint({
			hmacSecretEncrypted: await storedCiphertext('package-owned-hmac-value'),
		}),
	})
	expect(value).toBe('package-owned-hmac-value')
	await expect(
		resolveWebhookHmacSigningSecret({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint(),
		}),
	).rejects.toThrow(/package-owned signing secret/)
	expect(resolveSecret).not.toHaveBeenCalled()
})

async function trackedDeclaredEndpoint(
	overrides: Partial<WebhookEndpointRecord> = {},
) {
	const declared = 'legacy-secret-store-value'
	return endpoint({
		hmacSecretName: stripeVerification.secretName,
		hmacVerificationSecretEncrypted: await storedCiphertext(declared),
		...overrides,
	})
}

test('inbound verification tries a declared secretName before the stored generated secret', async () => {
	vi.mocked(resolveSecret).mockClear()
	vi.mocked(resolveSecret).mockResolvedValue({
		found: true,
		credentialId: 'cred-legacy-webhook-secret',
		value: 'legacy-secret-store-value',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		placement: null,
		scope: 'user',
	})
	const secrets = await resolveSecrets({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: await trackedDeclaredEndpoint({
			hmacSecretEncrypted: await storedCiphertext(
				'kody-generated-at-migration',
			),
		}),
		verification: stripeVerification,
	})
	expect(secrets).toEqual([
		{ value: 'legacy-secret-store-value', source: 'declared' },
		{ value: 'kody-generated-at-migration', source: 'stored' },
	])
	expect(resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({ name: 'stripeWebhookSecretCancelFarewell' }),
	)
})

test('inbound verification lists a stored copy of the declared secret once', async () => {
	vi.mocked(resolveSecret).mockResolvedValue({
		found: true,
		credentialId: 'cred-legacy-webhook-secret',
		value: 'legacy-secret-store-value',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		placement: null,
		scope: 'user',
	})
	const secrets = await resolveSecrets({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: await trackedDeclaredEndpoint({
			hmacSecretEncrypted: await storedCiphertext('legacy-secret-store-value'),
		}),
		verification: stripeVerification,
	})
	expect(secrets).toEqual([
		{ value: 'legacy-secret-store-value', source: 'declared' },
	])
})

test('inbound verification keeps the stored secret when the declared one cannot be read', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.mocked(findSecretForUse).mockRejectedValueOnce(new Error('not found'))
	const secrets = await resolveSecrets({
		env,
		userId: ownerIdFromStored('user-1'),
		endpoint: await trackedDeclaredEndpoint({
			hmacSecretEncrypted: await storedCiphertext(
				'kody-generated-at-migration',
			),
		}),
		verification: stripeVerification,
	})
	expect(secrets).toEqual([
		{ value: 'kody-generated-at-migration', source: 'stored' },
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-declared-secret-resolve-failed',
		expect.objectContaining({
			secretName: 'stripeWebhookSecretCancelFarewell',
		}),
	)

	vi.mocked(findSecretForUse).mockRejectedValueOnce(new Error('not found'))
	await expect(
		resolveSecrets({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint(),
			verification: stripeVerification,
		}),
	).rejects.toThrow(/stripeWebhookSecretCancelFarewell/)
})

test('an unreadable stored secret does not block a resolved declared secret', async () => {
	consoleWarn.mockImplementation(() => {})
	vi.mocked(resolveSecret).mockResolvedValue({
		found: true,
		credentialId: 'cred-legacy-webhook-secret',
		value: 'legacy-secret-store-value',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		placement: null,
		scope: 'user',
	})
	const unreadable = await trackedDeclaredEndpoint({
		hmacSecretEncrypted: 'not-a-ciphertext',
	})
	expect(
		await resolveSecrets({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: unreadable,
			verification: stripeVerification,
		}),
	).toEqual([{ value: 'legacy-secret-store-value', source: 'declared' }])
	expect(consoleWarn).toHaveBeenCalledWith(
		'webhook-stored-secret-decrypt-failed',
		expect.objectContaining({ endpointId: 'ep-1' }),
	)

	const { secretName: _secretName, ...withoutName } = stripeVerification
	await expect(
		resolveSecrets({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: unreadable,
			verification: withoutName,
		}),
	).rejects.toThrow()
})

test('inbound verification without secretName uses the stored secret and no lookup', async () => {
	vi.mocked(resolveSecret).mockClear()
	const { secretName: _secretName, ...withoutName } = stripeVerification
	expect(
		await resolveSecrets({
			env,
			userId: ownerIdFromStored('user-1'),
			endpoint: endpoint({
				hmacSecretEncrypted: await storedCiphertext('package-owned-hmac'),
			}),
			verification: withoutName,
		}),
	).toEqual([{ value: 'package-owned-hmac', source: 'stored' }])
	expect(resolveSecret).not.toHaveBeenCalled()
})

test('resolveHmacCiphertextForMint copies legacy secretName onto the endpoint', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: 'user-1',
		username: 'ada',
	})
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		// Opt out of credential-resolution audit writes (#3456).
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	vi.mocked(resolveSecret).mockClear()
	const encrypted = await resolveHmacCiphertextForMint({
		env,
		request: sessionRequestContext('user-1', 'ada'),
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		endpointId: 'ep-1',
		packageId: 'pkg-1',
		verification: {
			type: 'hmac-sha256',
			header: 'x-hub-signature-256',
			encoding: 'hex',
			secretName: 'prDeskGithubWebhookSecret',
		},
		existingHmacEncrypted: null,
	})
	expect(encrypted).toBeTruthy()
	expect(
		await decryptWebhookHmacSecret(
			env,
			encrypted!,
			userWebhookHmacSecretContext(ownerIdFromStored('user-1'), 'ep-1'),
		),
	).toBe('legacy-secret-store-value')
	expect(resolveSecret).toHaveBeenCalled()

	// A stored secret is kept: apply grants and a rotated URL's grace window
	// still depend on it. Ingress tries the declared secret first instead.
	const generated = await storedCiphertext('kody-generated-at-migration')
	const { secretName: _secretName, ...withoutName } = stripeVerification
	for (const verification of [stripeVerification, withoutName]) {
		expect(
			await resolveHmacCiphertextForMint({
				env,
				request: sessionRequestContext('user-1', 'ada'),
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('user-1'),
				endpointId: 'ep-1',
				packageId: 'pkg-1',
				verification,
				existingHmacEncrypted: generated,
			}),
		).toBeUndefined()
	}
})

async function seededEndpointEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	await provisionPersonalOrgForSqliteUser(sqlite, {
		stableUserId: 'user-1',
		username: 'ada',
	})
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		// Opt out of credential-resolution audit writes (#3456).
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	const userId = ownerIdFromStored('user-1')
	const endpointId = 'ep-rotate-1'
	await upsertWebhookEndpointSecret({
		db,
		id: endpointId,
		userId,
		packageId: 'pkg-1',
		webhookName: 'stripe',
		urlSecretHash: 'hash',
		urlSecretEncrypted: 'url-cipher',
		hmacSecretEncrypted: await encryptWebhookHmacSecret(
			env,
			'package-owned-unused',
			userWebhookHmacSecretContext(userId, endpointId),
		),
		enabled: true,
		now: '2026-07-24T00:00:00.000Z',
	})
	const previousPlaintext = 'stripe-signing-secret-v1'
	const snapshot = await encryptWebhookVerificationSnapshot({
		env,
		userId,
		endpointId,
		plaintext: previousPlaintext,
	})
	await setWebhookEndpointHmacVerificationState({
		db,
		userId,
		endpointId,
		hmacSecretName: 'stripeWebhookSecretCancelFarewell',
		hmacVerificationSecretEncrypted: snapshot,
	})
	const record = await getWebhookEndpointByIdForUser({
		db,
		userId,
		endpointId,
	})
	if (!record) throw new Error('endpoint missing')
	return { env, userId, endpointId, record, previousPlaintext }
}

test('signing-secret rotation: new secret verifies and an unrelated secret does not appear', async () => {
	const { env, userId, record, previousPlaintext } = await seededEndpointEnv()
	const rotatedAt = new Date('2026-07-24T12:00:00.000Z')
	await rotateWebhookHmacSecretsForSecretValueChange({
		env,
		userId,
		secretName: 'stripeWebhookSecretCancelFarewell',
		previousPlaintext,
		nextPlaintext: 'stripe-signing-secret-v2',
		now: rotatedAt,
	})
	vi.mocked(resolveSecret).mockResolvedValue({
		found: true,
		credentialId: 'cred-stripe',
		value: 'stripe-signing-secret-v2',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		placement: null,
		scope: 'user',
	})
	const endpoint = await getWebhookEndpointByIdForUser({
		db: env.APP_DB,
		userId,
		endpointId: record.id,
	})
	const secrets = await resolveSecrets({
		env,
		userId,
		endpoint: endpoint!,
		verification: stripeVerification,
		now: rotatedAt,
	})
	expect(
		secrets.some((secret) => secret.value === 'stripe-signing-secret-v2'),
	).toBe(true)
	expect(
		secrets.some((secret) => secret.value === 'unrelated-other-secret'),
	).toBe(false)
})

test('user-scoped rotation skips endpoints whose package owns the same secretName', async () => {
	const { env, userId, record, previousPlaintext } = await seededEndpointEnv()
	await upsertSecretBucket({
		db: env.APP_DB,
		row: {
			id: 'bucket-pkg-1',
			user_id: userId,
			scope: 'package',
			binding_key: 'pkg-1',
			expires_at: null,
		},
	})
	await upsertSecretEntry({
		db: env.APP_DB,
		row: {
			bucket_id: 'bucket-pkg-1',
			name: 'stripeWebhookSecretCancelFarewell',
			description: '',
			encrypted_value: await encryptSecretValue(
				env,
				'package-stripe-value',
				userSecretContext(userId),
			),
			allowed_hosts: '[]',
			allowed_packages: '[]',
			expires_at: null,
		},
	})
	const updated = await rotateWebhookHmacSecretsForSecretValueChange({
		env,
		userId,
		secretName: 'stripeWebhookSecretCancelFarewell',
		previousPlaintext,
		nextPlaintext: 'user-stripe-v2',
		now: new Date('2026-07-24T12:00:00.000Z'),
	})
	expect(updated).toBe(0)
	const endpoint = await getWebhookEndpointByIdForUser({
		db: env.APP_DB,
		userId,
		endpointId: record.id,
	})
	expect(endpoint?.previousHmacSecretEncrypted).toBeNull()
	expect(endpoint?.hmacVerificationSecretEncrypted).toBeTruthy()
})

test('dropping secretName clears declared tracking so leftover name rotates cannot rearm previous', async () => {
	const { env, userId, record, previousPlaintext } = await seededEndpointEnv()
	const { secretName: _secretName, ...withoutName } = stripeVerification
	const secrets = await resolveSecrets({
		env,
		userId,
		endpoint: record,
		verification: withoutName,
		now: new Date('2026-07-24T12:00:00.000Z'),
	})
	expect(secrets.map((secret) => secret.source)).toEqual(['stored'])
	expect(secrets.map((secret) => secret.value)).not.toContain(previousPlaintext)
	const cleared = await getWebhookEndpointByIdForUser({
		db: env.APP_DB,
		userId,
		endpointId: record.id,
	})
	expect(cleared?.hmacSecretName).toBeNull()
	expect(cleared?.hmacVerificationSecretEncrypted).toBeNull()
	expect(cleared?.previousHmacSecretEncrypted).toBeNull()

	const updated = await rotateWebhookHmacSecretsForSecretValueChange({
		env,
		userId,
		secretName: 'stripeWebhookSecretCancelFarewell',
		previousPlaintext,
		nextPlaintext: 'stripe-signing-secret-v2',
		now: new Date('2026-07-24T12:30:00.000Z'),
	})
	expect(updated).toBe(0)
	const afterRotate = await getWebhookEndpointByIdForUser({
		db: env.APP_DB,
		userId,
		endpointId: record.id,
	})
	expect(afterRotate?.previousHmacSecretEncrypted).toBeNull()
})

test('secretName rename records previous identity and accepts the old value within grace', async () => {
	const { env, userId, record, previousPlaintext } = await seededEndpointEnv()
	const renamedAt = new Date('2026-07-24T12:00:00.000Z')
	vi.mocked(resolveSecret).mockResolvedValue({
		found: true,
		credentialId: 'cred-stripe-new',
		value: 'stripe-signing-secret-renamed',
		allowedHosts: [],
		allowedPackages: ['pkg-1'],
		placement: null,
		scope: 'user',
	})
	const secrets = await resolveSecrets({
		env,
		userId,
		endpoint: record,
		verification: {
			...stripeVerification,
			secretName: 'stripeWebhookSecretNewName',
		},
		now: renamedAt,
	})
	expect(secrets).toEqual(
		expect.arrayContaining([
			{
				value: 'stripe-signing-secret-renamed',
				source: 'declared',
			},
			{ value: previousPlaintext, source: 'previous' },
		]),
	)
	const stored = await getWebhookEndpointByIdForUser({
		db: env.APP_DB,
		userId,
		endpointId: record.id,
	})
	expect(stored?.hmacSecretName).toBe('stripeWebhookSecretNewName')
	expect(stored?.previousHmacSecretName).toBe(
		'stripeWebhookSecretCancelFarewell',
	)
	expect(stored?.previousHmacSecretExpiresAt).toBeTruthy()
})
