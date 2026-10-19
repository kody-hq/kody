import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	createMissingSecretMessage,
	parseSecretScopeUnavailableMessage,
} from './errors.ts'
import {
	listPackageSecretsByPackageIds,
	listSecrets,
	listUserSecretsForSearch,
	resolveSecret,
	saveSecret,
	setSecretAllowedPackages,
	setSecretsAtomically,
	updateSecret,
	updateUserSecretForPackage,
	updateUserSecretsForPackageAtomically,
} from './service.ts'
import { createUnresolvedSecretMessage } from './unresolved-secret.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)
const userId = ownerIdFromStored('user-123')
const executeContext = ctx()

function ctx(packageId: string | null = null, sessionId: string | null = null) {
	return { sessionId, appId: null, packageId, storageId: packageId }
}

async function createSecretEnv(
	input: { email?: string; plan?: string; seededSecretCount?: number } = {},
) {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	if (input.email) {
		const stableUserId = testStableUserIdFromEmail(input.email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, password_hash, stable_user_id)
				 VALUES (1, 'planned', ?, 'hash', ?)`,
			)
			.run(input.email, stableUserId)
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, plan, created_at, updated_at)
				 VALUES (?, 'planned', ?, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`,
			)
			.run(stableUserId, input.plan ?? 'free')
		if (input.seededSecretCount) {
			sqlite
				.prepare(
					`INSERT INTO secret_buckets (id, user_id, scope, binding_key) VALUES ('seeded', ?, 'user', '')`,
				)
				.run(stableUserId)
			const insertEntry = sqlite.prepare(
				`INSERT INTO secret_entries (bucket_id, name, encrypted_value) VALUES ('seeded', ?, 'seeded-value')`,
			)
			for (let index = 0; index < input.seededSecretCount; index += 1) {
				insertEntry.run(`seeded-secret-${index}`)
			}
		}
	}
	return {
		sqlite,
		env: {
			APP_DB: createD1FromSqlite(sqlite),
			COOKIE_SECRET: 'test-cookie-secret',
			SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			...createInMemoryUserMeterEnv().env,
		},
	}
}

function rejection(promise: Promise<unknown>) {
	return promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)
}

test('resolveSecret returns the first scope hit in precedence order and ignores a corrupted lower scope', async () => {
	const { env, sqlite } = await createSecretEnv()
	const name = 'shared-secret'
	const storageContext = ctx('package-xyz', 'session-abc')
	await saveSecret({ env, userId, scope: 'user', name, value: 'user-value' })
	await saveSecret({
		env,
		userId,
		scope: 'package',
		name,
		value: 'package-value',
		storageContext,
	})
	await saveSecret({
		env,
		userId,
		scope: 'session',
		name,
		value: 'session-value',
		storageContext,
		sessionExpiresAt: '2099-01-01T00:00:00.000Z',
	})
	const sessionHit = {
		credentialId: expect.any(String),
		found: true,
		value: 'session-value',
		scope: 'session',
		allowedHosts: [],
		allowedPackages: [],
		placement: { headers: true },
	}
	await expect(
		resolveSecret({ env, userId, name, storageContext }),
	).resolves.toEqual(sessionHit)

	sqlite
		.prepare(
			`UPDATE secret_entries SET encrypted_value = 'not-valid-ciphertext'
			 WHERE name = ? AND bucket_id IN (SELECT id FROM secret_buckets WHERE scope = 'user')`,
		)
		.run(name)
	await expect(
		resolveSecret({ env, userId, name, scope: 'user' }),
	).rejects.toThrow('Unable to decrypt secret value.')
	await expect(
		resolveSecret({ env, userId, name, storageContext }),
	).resolves.toEqual(sessionHit)
})

test('saveSecret rejects unavailable scoped storage as McpCallerError', async () => {
	const { env } = await createSecretEnv()
	for (const scope of ['session', 'package'] as const) {
		await expect(
			saveSecret({
				env,
				userId,
				scope,
				name: 'token',
				value: `missing-${scope}`,
				storageContext: { sessionId: null, appId: null, packageId: null },
			}),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof McpCallerError &&
				error.message ===
					`Secret scope "${scope}" is unavailable in this context.`,
		)
	}
})

test('listSecrets from execute lists caller-owned package metadata without weakening resolve', async () => {
	const { env } = await createSecretEnv()
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'accountToken',
		value: 'user-value',
	})
	for (const [packageId, name, value] of [
		['pkg-discord', 'discordBotToken', 'package-only-value'],
		['pkg-notes', 'notesToken', 'notes-only-value'],
	] as const) {
		await saveSecret({
			env,
			userId,
			scope: 'package',
			name,
			value,
			storageContext: ctx(packageId),
		})
	}
	await saveSecret({
		env,
		userId,
		scope: 'session',
		name: 'sessionToken',
		value: 'session-only-value',
		storageContext: ctx(null, 'session-abc'),
		sessionExpiresAt: '2099-01-01T00:00:00.000Z',
	})
	await saveSecret({
		env,
		userId: ownerIdFromStored('user-other'),
		scope: 'package',
		name: 'foreignToken',
		value: 'other-user-value',
		storageContext: ctx('pkg-foreign'),
	})
	const discord = expect.objectContaining({
		name: 'discordBotToken',
		scope: 'package',
		packageId: 'pkg-discord',
	})
	const notes = expect.objectContaining({
		name: 'notesToken',
		scope: 'package',
		packageId: 'pkg-notes',
	})
	const account = expect.objectContaining({
		name: 'accountToken',
		scope: 'user',
		packageId: null,
	})

	const listedAll = await listSecrets({
		env,
		userId,
		storageContext: executeContext,
	})
	expect(listedAll).toEqual(expect.arrayContaining([account, discord, notes]))
	expect(listedAll.map((secret) => secret.name)).not.toContain('sessionToken')
	expect(listedAll.map((secret) => secret.name)).not.toContain('foreignToken')
	expect(
		listedAll.find((secret) => secret.name === 'discordBotToken'),
	).not.toHaveProperty('value')
	await expect(
		listSecrets({
			env,
			userId,
			scope: 'package',
			storageContext: executeContext,
		}),
	).resolves.toEqual([discord, notes])
	await expect(
		listSecrets({
			env,
			userId,
			scope: 'package',
			storageContext: ctx('pkg-discord'),
		}),
	).resolves.toEqual([discord])
	await expect(listUserSecretsForSearch({ env, userId })).resolves.toEqual([
		account,
	])

	const grouped = await listPackageSecretsByPackageIds({
		env,
		userId,
		packageIds: ['pkg-discord', 'pkg-missing', 'pkg-foreign'],
	})
	expect(grouped.get('pkg-discord')).toEqual([discord])
	expect(grouped.has('pkg-missing')).toBe(false)
	expect(grouped.has('pkg-foreign')).toBe(false)

	for (const input of [
		{ storageContext: executeContext },
		{ scope: 'package' as const, storageContext: executeContext },
	]) {
		await expect(
			resolveSecret({ env, userId, name: 'discordBotToken', ...input }),
		).resolves.toMatchObject({ found: false, value: null })
	}
	const executeMiss = await createUnresolvedSecretMessage({
		env,
		userId,
		name: 'discordBotToken',
		storageContext: executeContext,
		baseUrl: 'https://example.com',
	})
	expect(parseSecretScopeUnavailableMessage(executeMiss)).toEqual({
		secretName: 'discordBotToken',
		scope: 'package',
		packageName: null,
		packageId: 'pkg-discord',
	})
	await expect(
		createUnresolvedSecretMessage({
			env,
			userId,
			name: 'noSuchSecret',
			baseUrl: 'https://example.com',
		}),
	).resolves.toBe(createMissingSecretMessage('noSuchSecret'))
	await expect(
		resolveSecret({
			env,
			userId,
			name: 'discordBotToken',
			storageContext: ctx('pkg-discord'),
		}),
	).resolves.toMatchObject({
		found: true,
		value: 'package-only-value',
		scope: 'package',
	})
})

test('package writes to user secrets require every package approval and apply atomically', async () => {
	const { env } = await createSecretEnv()
	const resolveUser = (name: string) =>
		resolveSecret({ env, userId, scope: 'user', name })
	for (const [name, value] of [
		['shared-token', 'old-value'],
		['xRefreshToken', 'old-refresh'],
		['xAccessToken', 'old-access'],
	] as const) {
		await saveSecret({ env, userId, scope: 'user', name, value })
	}
	for (const name of ['shared-token', 'xRefreshToken']) {
		await setSecretAllowedPackages({
			env,
			userId,
			scope: 'user',
			name,
			allowedPackages: ['package-1'],
		})
	}

	await expect(
		updateUserSecretForPackage({
			env,
			userId,
			packageId: 'package-1',
			name: 'shared-token',
			value: 'new-value',
			description: 'Updated by package',
		}),
	).resolves.toMatchObject({
		name: 'shared-token',
		description: 'Updated by package',
		allowedPackages: ['package-1'],
	})
	await expect(resolveUser('shared-token')).resolves.toMatchObject({
		found: true,
		value: 'new-value',
	})
	await expect(
		updateUserSecretForPackage({
			env,
			userId,
			packageId: 'package-2',
			name: 'shared-token',
			value: 'unauthorized-value',
		}),
	).rejects.toThrow('not approved for package "package-2"')

	// Access token has no package grant yet: neither secret may change.
	await expect(
		updateUserSecretsForPackageAtomically({
			env,
			userId,
			packageId: 'package-1',
			secrets: [
				{ name: 'xRefreshToken', value: 'new-refresh' },
				{ name: 'xAccessToken', value: 'new-access' },
			],
		}),
	).rejects.toThrow('not approved for package "package-1"')
	await expect(resolveUser('xRefreshToken')).resolves.toMatchObject({
		found: true,
		value: 'old-refresh',
	})
	await expect(resolveUser('xAccessToken')).resolves.toMatchObject({
		found: true,
		value: 'old-access',
	})

	await setSecretAllowedPackages({
		env,
		userId,
		scope: 'user',
		name: 'xAccessToken',
		allowedPackages: ['package-1'],
	})
	await setSecretsAtomically({
		env,
		userId,
		secrets: [
			{ name: 'xRefreshToken', value: 'new-refresh', scope: 'user' },
			{ name: 'xAccessToken', value: 'new-access', scope: 'user' },
		],
		storageContext: { ...ctx('package-1'), storageId: null },
	})
	await expect(resolveUser('xRefreshToken')).resolves.toMatchObject({
		found: true,
		value: 'new-refresh',
	})
	await expect(resolveUser('xAccessToken')).resolves.toMatchObject({
		found: true,
		value: 'new-access',
	})
})

test('saveSecret enforces plan secret quotas including updates and max ceiling', async () => {
	const email = 'planned@example.com'
	const plannedUserId = testStableUserIdFromEmail(email)
	const { env } = await createSecretEnv({ email, plan: 'pro' })
	const limit = planLimits.pro.maxSecrets
	if (limit === null) throw new Error('Expected a numeric pro secret limit.')
	const save = (targetEnv: typeof env, name: string, value = 'secret-value') =>
		saveSecret({
			env: targetEnv,
			userId: ownerIdFromStored(plannedUserId),
			userEmail: email,
			scope: 'user',
			name,
			value,
		})

	for (let index = 0; index < limit; index += 1) {
		await save(env, `quota-secret-${index}`)
	}
	const overLimit = await rejection(save(env, `quota-secret-${limit}`))
	if (!isEntitlementLimitError(overLimit)) {
		throw new Error('Expected an EntitlementLimitError from saveSecret.')
	}
	expect(overLimit.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'secrets',
		plan: 'pro',
		limit,
		current: limit,
	})
	await expect(
		saveSecret({
			env,
			userId: ownerIdFromStored(plannedUserId),
			userEmail: email,
			scope: 'user',
			name: 'quota-secret-0',
			value: 'rotated-value',
			description: 'rotated',
		}),
	).resolves.toMatchObject({ name: 'quota-secret-0', description: 'rotated' })

	const maxLimit = planLimits.max.maxSecrets
	const belowMax = await createSecretEnv({
		email,
		plan: 'max',
		seededSecretCount: limit + 1,
	})
	await save(belowMax.env, 'below-max-secret')
	const atCeiling = await createSecretEnv({
		email,
		plan: 'max',
		seededSecretCount: maxLimit ?? 0,
	})
	const ceilingError = await rejection(save(atCeiling.env, 'over-max-secret'))
	if (!isEntitlementLimitError(ceilingError)) {
		throw new Error(
			'Expected an EntitlementLimitError at the max secret ceiling.',
		)
	}
	expect(ceilingError.details).toMatchObject({
		resource: 'secrets',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})

test('user secrets persist per-entry expiry, stay listed after expiry, and fail closed on resolve', async () => {
	const { env } = await createSecretEnv()
	const resolvePat = (includeExpired?: boolean) =>
		resolveSecret({
			env,
			userId,
			name: 'githubPat',
			scope: 'user',
			...(includeExpired ? { includeExpired } : {}),
		})
	const futureDateOnly = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10)
	const futureIso = `${futureDateOnly}T00:00:00.000Z`
	const savePat = (expiresAt: string) =>
		saveSecret({
			env,
			userId,
			scope: 'user',
			name: 'githubPat',
			value: 'ghp_old',
			expiresAt,
		})

	const saved = await savePat(futureDateOnly)
	expect(saved.expiresAt).toBe(futureIso)
	expect(saved.ttlMs).toBeGreaterThan(0)
	await expect(resolvePat()).resolves.toMatchObject({
		found: true,
		value: 'ghp_old',
	})
	await expect(listSecrets({ env, userId, scope: 'user' })).resolves.toEqual([
		expect.objectContaining({ name: 'githubPat', expiresAt: futureIso }),
	])

	const past = await savePat('2020-01-01T00:00:00.000Z')
	expect(past.ttlMs).toBe(0)
	await expect(resolvePat()).resolves.toMatchObject({
		found: false,
		value: null,
	})
	await expect(resolvePat(true)).resolves.toMatchObject({
		found: true,
		value: 'ghp_old',
	})
	await expect(listSecrets({ env, userId, scope: 'user' })).resolves.toEqual([
		expect.objectContaining({
			name: 'githubPat',
			expiresAt: '2020-01-01T00:00:00.000Z',
			ttlMs: 0,
			placement: null,
		}),
	])

	const cleared = await updateSecret({
		env,
		userId,
		scope: 'user',
		name: 'githubPat',
		expiresAt: null,
	})
	expect(cleared.expiresAt).toBeNull()
	expect(cleared.ttlMs).toBeNull()
	await expect(resolvePat()).resolves.toMatchObject({
		found: true,
		value: 'ghp_old',
	})
})

test('scope move can preserve anywhere placement; brand-new Keys stay headers-only', async () => {
	const { env } = await createSecretEnv()
	const packageContext = ctx('pkg-move')
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'legacyAnywhere',
		value: 'legacy-value',
		// Explicit null: simulate a pre-default row (or a move preserving anywhere).
		placementOnInsert: null,
	})
	await expect(
		resolveSecret({ env, userId, name: 'legacyAnywhere', scope: 'user' }),
	).resolves.toMatchObject({ found: true, placement: null })

	await saveSecret({
		env,
		userId,
		scope: 'package',
		name: 'legacyAnywhere',
		value: 'legacy-value',
		storageContext: packageContext,
		placementOnInsert: null,
	})
	await expect(
		resolveSecret({
			env,
			userId,
			name: 'legacyAnywhere',
			scope: 'package',
			storageContext: packageContext,
		}),
	).resolves.toMatchObject({ found: true, placement: null })

	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'brandNew',
		value: 'new-value',
	})
	await expect(
		resolveSecret({ env, userId, name: 'brandNew', scope: 'user' }),
	).resolves.toMatchObject({ found: true, placement: { headers: true } })
})
