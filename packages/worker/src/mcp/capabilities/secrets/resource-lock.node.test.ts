import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import * as integrationService from '#worker/integrations/service.ts'
import * as mcpServerService from '#worker/mcp-client/settings-service.ts'
import {
	listSecrets,
	lockSecretToPackage,
	saveSecret,
} from '#mcp/secrets/service.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import type { PackageLockOutcome } from '#mcp/secrets/allowed-packages.ts'
import { inspectSecretProviderPackageGrant } from '#mcp/secrets/secret-providers/service.ts'
import { resourceLockCapability } from './resource-lock.ts'

const migrationsDirectory = new URL('../../../../migrations/', import.meta.url)

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { sqlite, env }
}

function seedPackage(
	sqlite: DatabaseSync,
	input: { id: string; userId: string; kodyId: string },
) {
	sqlite
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, source_id
			) VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			input.id,
			input.userId,
			input.kodyId,
			input.kodyId,
			'',
			`source-${input.id}`,
		)
}

async function allowedPackagesFor(
	env: Env,
	userId: string,
	name: string,
): Promise<Array<string>> {
	const secrets = await listSecrets({
		env,
		userId: ownerIdFromStored(userId),
		scope: 'user',
	})
	return secrets.find((secret) => secret.name === name)?.allowedPackages ?? []
}

afterEach(() => {
	vi.restoreAllMocks()
})

test('resourceLock returns a secret approval URL without widening allowed_packages', async () => {
	const { sqlite, env } = createHarness()
	const userId = ownerIdFromStored('user-secret-package-grant')
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, 'ada', ?, ?)`,
		)
		.run(userId, now, now)
	seedPackage(sqlite, { id: 'pkg-notes', userId, kodyId: 'notes' })
	seedPackage(sqlite, { id: 'pkg-mail', userId, kodyId: 'mail' })
	await saveSecret({
		env,
		userId,
		scope: 'user',
		name: 'openai-api-key',
		value: 'sk-test',
		audit: null,
	})

	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.codes',
			user: {
				userId: personIdFromStored('user-secret-package-grant'),
				username: 'alice',
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}

	const pending = await resourceLockCapability.handler(
		{ kind: 'secret', name: 'openai-api-key', package_id: 'pkg-notes' },
		ctx,
	)
	expect(pending).toMatchObject({
		kind: 'secret',
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: [],
		status: 'approval_required',
	})
	if (pending.kind !== 'secret') {
		throw new Error('Expected a secret resource lock result.')
	}
	const pendingApproval = new URL(pending.approval_url)
	expect(pendingApproval.origin).toBe('https://kody.codes')
	expect(pendingApproval.pathname).toBe('/@ada/-/secrets/user/openai-api-key')
	expect(pendingApproval.searchParams.get('package_id')).toBe('pkg-notes')
	expect(pendingApproval.searchParams.get('package')).toBe('notes')
	expect(pending.usage_url).toBe(
		`${pendingApproval.origin}${pendingApproval.pathname}`,
	)
	expect(pending.message).toContain(pending.approval_url)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([])

	const websiteGrant = await lockSecretToPackage({
		env,
		userId,
		name: 'openai-api-key',
		packageId: 'pkg-notes',
		audit: null,
	})
	expect(websiteGrant.allowedPackages).toEqual(['pkg-notes'])

	const alreadyGranted = await resourceLockCapability.handler(
		{ kind: 'secret', name: 'openai-api-key', package_id: 'pkg-notes' },
		ctx,
	)
	expect(alreadyGranted).toMatchObject({
		kind: 'secret',
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: ['pkg-notes'],
		status: 'already_granted',
	})
	if (alreadyGranted.kind !== 'secret') {
		throw new Error('Expected a secret resource lock result.')
	}
	expect(alreadyGranted.approval_url).toBe(pending.approval_url)
	expect(alreadyGranted.usage_url).toBe(pending.usage_url)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])

	const additional = await resourceLockCapability.handler(
		{ kind: 'secret', name: 'openai-api-key', package_id: 'pkg-mail' },
		ctx,
	)
	expect(additional.kind).toBe('secret')
	if (additional.kind !== 'secret') {
		throw new Error('Expected a secret resource lock result.')
	}
	expect(additional.status).toBe('approval_required')
	expect(additional.allowed_packages).toEqual(['pkg-notes'])
	const additionalApproval = new URL(additional.approval_url)
	expect(additionalApproval.origin).toBe('https://kody.codes')
	expect(additionalApproval.pathname).toBe(
		'/@ada/-/secrets/user/openai-api-key',
	)
	expect(additionalApproval.searchParams.get('package_id')).toBe('pkg-mail')
	expect(additionalApproval.searchParams.get('package')).toBe('mail')
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])

	const missingPackage = await resourceLockCapability
		.handler(
			{ kind: 'secret', name: 'openai-api-key', package_id: 'missing' },
			ctx,
		)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingPackage).toBeInstanceOf(McpCallerError)
	expect((missingPackage as Error).message).toContain('Saved package not found')

	const missingSecret = await resourceLockCapability
		.handler(
			{ kind: 'secret', name: 'missing-secret', package_id: 'pkg-notes' },
			ctx,
		)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missingSecret).toBeInstanceOf(McpCallerError)
	expect((missingSecret as Error).message).toMatch(
		/Secret "missing-secret" not found in user scope/,
	)
	expect(await allowedPackagesFor(env, userId, 'openai-api-key')).toEqual([
		'pkg-notes',
	])
})

test('resourceLock requires the permission mapped to each kind before side effects', async () => {
	const { sqlite, env } = createHarness()
	const ownerId = ownerIdFromStored('user-resource-lock-auth')
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, 'alice', ?, ?)`,
		)
		.run(ownerId, now, now)
	const user = {
		userId: personIdFromStored('user-resource-lock-auth'),
		username: 'alice',
		email: 'alice@example.com',
		displayName: 'Alice',
	}
	const contextFor = (scopes: Array<'secret:use' | 'integration:use'>) => ({
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			scopes,
			baseUrl: 'https://kody.codes',
			user,
		}),
	})
	const lockIntegrationSpy = vi
		.spyOn(integrationService, 'lockIntegrationToPackage')
		.mockResolvedValue({ name: 'google', allowedPackageIds: [] } as never)
	const lockMcpServerSpy = vi
		.spyOn(mcpServerService, 'lockMcpServerToPackage')
		.mockResolvedValue({
			id: 'server-id',
			name: 'exa',
			allowedPackageIds: [],
		} as never)

	const cases = [
		{
			kind: 'secret',
			permission: 'secret:use',
			args: {
				kind: 'secret',
				name: 'not-read',
				package_id: 'not-locked',
			},
		},
		{
			kind: 'secret_provider',
			permission: 'secret:use',
			args: {
				kind: 'secret_provider',
				provider: '1password',
				ref: 'i/ref/field',
				package_id: 'not-locked',
			},
		},
		{
			kind: 'integration',
			permission: 'integration:use',
			args: {
				kind: 'integration',
				name: 'google',
				package_id: 'not-locked',
			},
		},
		{
			kind: 'mcp_server',
			permission: 'integration:use',
			args: {
				kind: 'mcp_server',
				server: 'exa',
				package_id: 'not-locked',
			},
		},
	] as const

	for (const entry of cases) {
		const denied = await resourceLockCapability
			.handler(entry.args, contextFor([]))
			.then(
				() => null,
				(error: unknown) => error,
			)
		expect(denied, `${entry.kind} without permission`).toBeInstanceOf(
			AuthorizationError,
		)
		expect((denied as AuthorizationError).permission).toBe(entry.permission)
	}

	for (const entry of cases) {
		const otherPermission =
			entry.permission === 'secret:use' ? 'integration:use' : 'secret:use'
		const denied = await resourceLockCapability
			.handler(entry.args, contextFor([otherPermission]))
			.then(
				() => null,
				(error: unknown) => error,
			)
		expect(denied, `${entry.kind} with only ${otherPermission}`).toBeInstanceOf(
			AuthorizationError,
		)
		expect((denied as AuthorizationError).permission).toBe(entry.permission)
	}

	expect(lockIntegrationSpy).not.toHaveBeenCalled()
	expect(lockMcpServerSpy).not.toHaveBeenCalled()
})

function scopedLockHarness(
	slug: string,
	scopes: Array<'secret:use' | 'integration:use'>,
) {
	const { sqlite, env } = createHarness()
	env.AUDIT_DB = createAuditTestDb()
	const ownerId = ownerIdFromStored(`user-${slug}`)
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		)
		.run(ownerId, slug, now, now)
	seedPackage(sqlite, { id: 'pkg-drafts', userId: ownerId, kodyId: 'drafts' })
	seedPackage(sqlite, { id: 'pkg-sender', userId: ownerId, kodyId: 'sender' })
	const ctx = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			scopes,
			baseUrl: 'https://kody.codes',
			user: {
				userId: personIdFromStored(`user-${slug}`),
				username: slug,
				email: `${slug}@example.com`,
				displayName: slug,
			},
		}),
	}
	return { sqlite, env, ownerId, ctx }
}

type LockRow = {
	permission: 'secret:use' | 'integration:use'
	/** A first lock only applies when it narrows access to the resource. */
	firstLock: PackageLockOutcome
	setup: (h: ReturnType<typeof scopedLockHarness>) => Promise<{
		args: (
			packageId: string,
		) => Parameters<typeof resourceLockCapability.handler>[0]
		allowed: () => Promise<Array<string>>
	}>
}

const providerRef = 'i/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/password'

/**
 * One row per resourceLock kind. Agents may narrow access; only the owner
 * widens it. A kind added to the input schema without a row fails below.
 */
const lockContract: Record<string, LockRow> = {
	secret: {
		permission: 'secret:use',
		firstLock: 'approval_required',
		async setup({ env, ownerId }) {
			await saveSecret({
				env,
				userId: ownerId,
				scope: 'user',
				name: 'openai-api-key',
				value: 'sk-test',
				audit: null,
			})
			return {
				args: (packageId) => ({
					kind: 'secret',
					name: 'openai-api-key',
					package_id: packageId,
				}),
				allowed: () => allowedPackagesFor(env, ownerId, 'openai-api-key'),
			}
		},
	},
	secret_provider: {
		permission: 'secret:use',
		firstLock: 'approval_required',
		async setup({ sqlite, env, ownerId }) {
			seedPackage(sqlite, { id: 'pkg-op', userId: ownerId, kodyId: 'op' })
			sqlite
				.prepare(
					`INSERT INTO secret_provider_bindings (
						user_id, provider_id, package_id, door_secret_name, config_json
					) VALUES (?, '1password', 'pkg-op', 'doorKey', '{}')`,
				)
				.run(ownerId)
			const granted = async (packageId: string) =>
				(
					await inspectSecretProviderPackageGrant({
						env,
						userId: ownerId,
						providerId: '1password',
						ref: providerRef,
						packageId,
					})
				).alreadyGranted
			return {
				args: (packageId) => ({
					kind: 'secret_provider',
					provider: '1password',
					ref: providerRef,
					package_id: packageId,
				}),
				allowed: async () =>
					(
						await Promise.all(
							['pkg-drafts', 'pkg-sender'].map(async (id) =>
								(await granted(id)) ? [id] : [],
							),
						)
					).flat(),
			}
		},
	},
	integration: {
		permission: 'integration:use',
		firstLock: 'locked',
		async setup({ env, ownerId }) {
			await integrationService.upsertIntegration({
				env,
				userId: ownerId,
				config: {
					name: 'google',
					tokenUrl: 'https://oauth2.googleapis.com/token',
					apiBaseUrl: 'https://www.googleapis.com',
					flow: 'confidential',
					clientId: 'google-client-id',
					requiredHosts: ['www.googleapis.com'],
				},
				audit: null,
			})
			return {
				args: (packageId) => ({
					kind: 'integration',
					name: 'google',
					package_id: packageId,
				}),
				allowed: async () =>
					(
						await integrationService.getJoinedIntegration({
							env,
							userId: ownerId,
							name: 'google',
						})
					)?.connection.allowedPackageIds ?? [],
			}
		},
	},
	mcp_server: {
		permission: 'integration:use',
		firstLock: 'locked',
		async setup({ sqlite, env, ownerId }) {
			sqlite
				.prepare(
					`INSERT INTO mcp_server_settings (id, user_id, name, url, enabled)
					 VALUES ('mcp-exa', ?, 'exa', 'https://mcp.example.com/mcp', 1)`,
				)
				.run(ownerId)
			return {
				args: (packageId) => ({
					kind: 'mcp_server',
					server: 'exa',
					package_id: packageId,
				}),
				allowed: async () =>
					(
						await mcpServerService.getMcpServerSettingById({
							env,
							userId: ownerId,
							id: 'mcp-exa',
						})
					)?.allowedPackageIds ?? [],
			}
		},
	},
}

function resourceLockKinds() {
	const kinds = new Set<string>()
	const visit = (node: unknown) => {
		if (!node || typeof node !== 'object') return
		const kind = (node as { properties?: { kind?: { const?: unknown } } })
			.properties?.kind?.const
		if (typeof kind === 'string') kinds.add(kind)
		for (const value of Object.values(node)) visit(value)
	}
	visit(resourceLockCapability.inputSchema)
	return [...kinds].sort()
}

test('every resourceLock kind has a narrow-only contract row', () => {
	expect(resourceLockKinds().length).toBeGreaterThan(0)
	expect(Object.keys(lockContract).sort()).toEqual(resourceLockKinds())
})

test.each(Object.entries(lockContract))(
	'resourceLock %s: a use-only caller cannot widen access',
	async (kind, row) => {
		const harness = scopedLockHarness(`lock-${kind.replace('_', '-')}`, [
			row.permission,
		])
		const { args, allowed } = await row.setup(harness)

		const first = await resourceLockCapability.handler(
			args('pkg-drafts'),
			harness.ctx,
		)
		expect(first.status).toBe(row.firstLock)
		const afterFirst = row.firstLock === 'locked' ? ['pkg-drafts'] : []
		expect(await allowed()).toEqual(afterFirst)

		const widen = await resourceLockCapability.handler(
			args('pkg-sender'),
			harness.ctx,
		)
		expect(widen.status).toBe('approval_required')
		expect(new URL(widen.approval_url).searchParams.get('package_id')).toBe(
			'pkg-sender',
		)
		expect(widen.message).toContain(widen.approval_url)
		expect(await allowed()).toEqual(afterFirst)
	},
)
