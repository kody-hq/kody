import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { signLocalExecutePackageBinding } from '#worker/package-runtime/local-execute-package-binding.ts'
import { type ApiInvocationContext } from './context.ts'
import { runCapabilityProxyAuthenticatedFetch } from './capability-proxy-authenticated-fetch.ts'
import { runCapabilityProxyOauthClientCredentials } from './capability-proxy-oauth-client-credentials.ts'
import { createCapabilityProxyPackageHostTools } from './capability-proxy-package-grants.ts'

const storageToolCalls = vi.hoisted(
	() =>
		[] as Array<{
			runPackageId: unknown
			grantedPackageIds: ReadonlySet<string>
			args: unknown
		}>,
)

vi.mock('#worker/storage-runner.ts', () => ({
	createPackageStorageAccessDeniedMessage: (packageId: string) =>
		`Package ${packageId} is not authorized for storage access.`,
	createPackageStorageKodyTools: (input: {
		runPackageId?: unknown
		grantedPackageIds: ReadonlySet<string>
	}) => ({
		packageStorageGet: async (args: unknown) => {
			storageToolCalls.push({
				runPackageId: input.runPackageId,
				grantedPackageIds: input.grantedPackageIds,
				args,
			})
			return { value: 'owned-storage-value' }
		},
	}),
}))

vi.mock('#worker/credentials/resolve-credential.ts', () => ({
	resolveCredential: async () => ({
		ref: 'owned-secret-ref',
		name: 'client-token',
		alias: 'client-token',
		scope: 'user',
		packageId: 'owned-package',
		kodyId: 'owned-package',
	}),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	buildKodyFns: async () => ({}),
}))

vi.mock('#mcp/execute-modules/kody-runtime-utils.ts', () => ({
	createAuthenticatedFetch: async () => async () => new Response('ok'),
	oauthClientCredentials: async () => ({ access_token: 'ok' }),
}))

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const callerUserId = 'a'.repeat(64)
const packageOwnerId = 'b'.repeat(64)
const ownedPackageId = 'owned-package'
const otherOrgPackageId = 'other-org-package'

function createDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, migrationsDirectory)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id)
			 VALUES ('local-caller', 'caller@example.com', 'hash', ?),
			        ('package-owner', 'owner@example.com', 'hash', ?)`,
		)
		.run(callerUserId, packageOwnerId)
	const packageRows: Array<[string, string]> = [
		[ownedPackageId, callerUserId],
		[otherOrgPackageId, packageOwnerId],
	]
	for (const [id, userId] of packageRows) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages
					(id, user_id, name, kody_id, description, source_id)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, userId, id, id, 'Test package', `source-${id}`)
	}
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function testEnv(db: D1Database) {
	return { APP_DB: db, SECRET_STORE_KEY: 'test-secret-store-key' } as Env
}

function createContext(db: D1Database): ApiInvocationContext {
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.codes',
		executionOrigin: 'interactive',
		user: {
			userId: personIdFromStored(callerUserId),
			email: 'caller@example.com',
			displayName: 'Caller',
		},
		storageContext: null,
		repoContext: null,
	})
	if (!callerContext.user) throw new Error('Caller context needs a user')
	return {
		env: testEnv(db),
		callerContext: { ...callerContext, user: callerContext.user },
		principal: { kind: 'mcp' },
		getFeatureFlags: async () => ({
			'demo-indicator': false,
			'connection-profiles': false,
			'mcp-skills-extension': false,
			'mcp-events-extension': false,
			'package-app-custom-domains': false,
			'package-credential-suppliers': false,
			'repo-push-queue': false,
			'execution-contexts': false,
			'credential-need-enforcement': false,
		}),
	}
}

/**
 * The binding the package graph would sign for this caller. `actor` lets a
 * test sign one for somebody else.
 */
async function bindingFor(
	db: D1Database,
	packageId: string,
	overrides: { actor?: string | null; now?: number } = {},
) {
	const { callerContext } = createContext(db)
	return await signLocalExecutePackageBinding({
		env: testEnv(db),
		packageId,
		subject: {
			org: ownerIdFromCaller(callerContext),
			actor:
				overrides.actor === undefined
					? (callerContext.request?.actor?.userId ?? null)
					: overrides.actor,
		},
		...(overrides.now === undefined ? {} : { now: overrides.now }),
	})
}

async function packageStorageGet(db: D1Database, packageId: string) {
	const tools = await createCapabilityProxyPackageHostTools({
		env: testEnv(db),
		callerContext: createContext(db).callerContext,
	})
	return tools.packageStorageGet?.({ packageId, key: 'cursor' })
}

async function packageSecretGet(db: D1Database, packageId: string) {
	const tools = await createCapabilityProxyPackageHostTools({
		env: testEnv(db),
		callerContext: createContext(db).callerContext,
	})
	return tools.packageSecretGet?.({ alias: 'client-token', packageId })
}

const packageOperations = [
	{
		name: 'packageStorageGet',
		run: packageStorageGet,
		expected: { value: 'owned-storage-value' },
	},
	{
		name: 'package secret get',
		run: packageSecretGet,
		expected: { value: 'owned-secret-ref' },
	},
	{
		name: 'authenticatedFetch',
		run: async (db: D1Database, packageId: string) =>
			runCapabilityProxyAuthenticatedFetch({
				ctx: createContext(db),
				args: [
					{
						providerName: 'test',
						packageId,
						request: { url: 'https://api.example.test/resource' },
					},
				],
			}),
		expected: {
			status: 200,
			statusText: '',
			headers: { 'content-type': 'text/plain;charset=UTF-8' },
			bodyBase64: 'b2s=',
		},
	},
	{
		name: 'oauthClientCredentials',
		run: async (db: D1Database, packageId: string) =>
			runCapabilityProxyOauthClientCredentials({
				ctx: createContext(db),
				args: [
					{
						tokenUrl: 'https://oauth.example.test/token',
						clientIdSecret: 'client-id',
						clientSecretSecret: 'client-secret',
						packageId,
					},
				],
			}),
		expected: { access_token: 'ok' },
	},
]

for (const operation of packageOperations) {
	test(`${operation.name} only accepts graph-signed bindings for caller-owned packages`, async () => {
		const { db } = createDb()

		await expect(
			operation.run(db, await bindingFor(db, ownedPackageId)),
		).resolves.toEqual(operation.expected)
		await expect(
			operation.run(db, await bindingFor(db, otherOrgPackageId)),
		).rejects.toThrow(/not authorized for storage access/)
		await expect(
			operation.run(db, await bindingFor(db, 'unknown-package')),
		).rejects.toThrow(/not authorized for storage access/)
	})

	test(`${operation.name} refuses a claimed package identity (GHSA-5fv3-qv7j-rqf5)`, async () => {
		const { db } = createDb()
		const valid = await bindingFor(db, ownedPackageId)
		const [body, signature] = valid.slice('kpb1.'.length).split('.')
		const forgedBody = btoa(
			JSON.stringify({
				...JSON.parse(atob(body!.replaceAll('-', '+').replaceAll('_', '/'))),
				pkg: otherOrgPackageId,
			}),
		)
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replace(/=+$/, '')
		const claims = [
			// A bare package id, even one the caller owns.
			ownedPackageId,
			// Signed for a different actor in the same org.
			await bindingFor(db, ownedPackageId, { actor: 'someone-else' }),
			// Expired.
			await bindingFor(db, ownedPackageId, {
				now: Date.now() - 25 * 60 * 60 * 1000,
			}),
			// Payload swapped under a valid signature.
			`kpb1.${forgedBody}.${signature}`,
		]
		for (const claim of claims) {
			await expect(operation.run(db, claim)).rejects.toThrow(
				/package identity is not valid for this local run/,
			)
		}
	})
}

test('packageStorage acts as the verified package, not the wire value', async () => {
	const { db } = createDb()
	storageToolCalls.length = 0
	const binding = await bindingFor(db, ownedPackageId)
	await expect(packageStorageGet(db, binding)).resolves.toEqual({
		value: 'owned-storage-value',
	})
	expect(storageToolCalls).toHaveLength(1)
	const [call] = storageToolCalls
	// The storage tools see the verified id, and act as that package so its
	// own bucket passes the owner-only check.
	expect(call?.runPackageId).toBe(ownedPackageId)
	expect([...(call?.grantedPackageIds ?? [])]).toEqual([ownedPackageId])
	expect(call?.args).toEqual({ key: 'cursor', packageId: ownedPackageId })
})
