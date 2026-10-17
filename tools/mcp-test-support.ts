import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { randomUUID } from 'node:crypto'
import { type Client } from '@modelcontextprotocol/sdk/client/index.js'
import { type CallToolRequest } from '@modelcontextprotocol/sdk/types.js'
import { createTestHarness } from 'wrangler'
import { buildLandingHeroVideosCacheKey } from '#worker/app/landing-hero-videos.ts'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import {
	landingHeroSourcePlaylistId,
	type LandingHeroVideo,
} from '#universal/landing-hero-copy.ts'
import { buildOriginTestApp } from './build-origin-test-app.ts'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import { ensureGuideCatalogModules } from './build-guide-catalog-modules.ts'
import { ensureWorkerBundlerModules } from './build-worker-bundler-modules.ts'
import {
	authorizeOAuthClient,
	closeMcpConnection,
	connectMcpClient,
	connectStatelessMcpClient,
	exchangeAuthorizationCode,
	loginToApp,
	registerOAuthClient,
	type AppAuthUser,
} from './mcp-oauth-client.ts'
import {
	buildSeedPersonalOrgSql,
	seedStableUserIdFromEmail,
} from './seed-sql.ts'

const projectRoot = process.cwd()
// Must satisfy the server-side password policy (see
// @kody-internal/shared/password-policy.ts). Matches the documented local seed
// fixture login (kody@example.com / ilikecode).
const testUserPassword = 'ilikecode'

type TestUser = AppAuthUser

type TestCallToolParams = CallToolRequest['params'] & {
	headers?: Record<string, string>
}

type ConnectedTestClient = {
	callTool(params: TestCallToolParams): ReturnType<Client['callTool']>
	listTools(): ReturnType<Client['listTools']>
}

export type SharedMcpE2eServer = {
	origin: string
	ensureUser(user: TestUser): Promise<void>
	markEmailVerified(email: string): Promise<void>
	assignRole(email: string, role: string): Promise<void>
	clearAuthRateLimits(): Promise<void>
	seedHeroVideos(videos: Array<LandingHeroVideo>): Promise<void>
	seedOAuthClient(
		clientId: string,
		registration: Record<string, unknown> | null,
	): Promise<void>
}

type SharedMcpE2eServerHandle = SharedMcpE2eServer & {
	close(): Promise<void>
}

type SharedMcpE2eGlobalState = {
	promise: Promise<SharedMcpE2eServerHandle> | null
	closing: Promise<void> | null
}

const sharedMcpE2eGlobalKey = Symbol.for('kody.mcpE2e.sharedServer')

function sharedMcpE2eGlobalState(): SharedMcpE2eGlobalState {
	const globalRef = globalThis as typeof globalThis & {
		[sharedMcpE2eGlobalKey]?: SharedMcpE2eGlobalState
	}
	globalRef[sharedMcpE2eGlobalKey] ??= {
		promise: null,
		closing: null,
	}
	return globalRef[sharedMcpE2eGlobalKey]
}

/**
 * One Wrangler test harness for the whole mcp-e2e project. State lives on
 * `globalThis` (and mcp-e2e sets `isolate: false`) so Vitest file isolation
 * cannot cold-boot again. Each test still seeds its own user/org.
 */
export async function getSharedMcpE2eServer(): Promise<SharedMcpE2eServer> {
	const state = sharedMcpE2eGlobalState()
	state.promise ??= startSharedMcpE2eServer()
	const server = await state.promise
	return {
		origin: server.origin,
		ensureUser: (user) => server.ensureUser(user),
		markEmailVerified: (email) => server.markEmailVerified(email),
		assignRole: (email, role) => server.assignRole(email, role),
		clearAuthRateLimits: () => server.clearAuthRateLimits(),
		seedHeroVideos: (videos) => server.seedHeroVideos(videos),
		seedOAuthClient: (id, registration) =>
			server.seedOAuthClient(id, registration),
	}
}

/** Dispose the shared harness (no-op when none is running). */
export async function stopSharedMcpE2eServer() {
	const state = sharedMcpE2eGlobalState()
	if (state.closing) return state.closing
	if (!state.promise) return
	state.closing ??= (async () => {
		const pending = state.promise
		state.promise = null
		const handle = await pending?.catch(() => null)
		await handle?.close()
	})()
	try {
		await state.closing
	} finally {
		state.closing = null
	}
}

/** Unique DNS-safe username + email so shared-DB tests stay isolated. */
export function createUniqueTestUser(): TestUser {
	const id = randomUUID().replace(/-/g, '').slice(0, 10)
	return {
		email: `mcp-${id}@example.com`,
		username: `u${id}`,
		password: testUserPassword,
	}
}

async function startSharedMcpE2eServer(): Promise<SharedMcpE2eServerHandle> {
	const started = await startHarnessWithCloudflareMock()
	return {
		origin: started.origin,
		ensureUser: started.ensureUser,
		markEmailVerified: started.markEmailVerified,
		assignRole: started.assignRole,
		clearAuthRateLimits: started.clearAuthRateLimits,
		seedHeroVideos: started.seedHeroVideos,
		seedOAuthClient: started.seedOAuthClient,
		close: started.close,
	}
}

async function startHarnessWithCloudflareMock() {
	await Promise.all([ensureWorkerBundlerModules(), ensureGuideCatalogModules()])
	const compiled = await buildOriginTestApp()
	const cloudflareMock = await startCloudflareMock(
		`mcp-e2e-cloudflare-${randomUUID()}`,
	).catch(async (error: unknown) => {
		await compiled.close()
		throw error
	})
	const cloudflareVars = {
		CLOUDFLARE_API_BASE_URL: cloudflareMock.origin,
		CLOUDFLARE_API_TOKEN: cloudflareMock.token,
		CLOUDFLARE_ACCOUNT_ID: 'cf_account_mock_123',
		CLOUDFLARE_API_SOURCE_SNAPSHOTS: 'true',
	}
	const harness = createTestHarness({
		root: projectRoot,
		workers: [
			{
				configPath: compiled.configPath,
				vars: cloudflareVars,
				bindingOverrides: {
					CLOUDFLARE_API_MOCK: 'kody-mock-cloudflare-test',
				},
			},
			{
				configPath: 'packages/mock-servers/cloudflare/wrangler.jsonc',
				env: 'test',
				vars: { MOCK_API_TOKEN: cloudflareMock.token },
			},
			{
				configPath: 'packages/jobs-worker/wrangler.jsonc',
				env: 'test',
			},
			{
				configPath: 'packages/highlight-worker/wrangler.jsonc',
				env: 'test',
			},
		],
	})
	try {
		const { url } = await harness.listen()
		const worker = harness.getWorker<{
			APP_DB: D1Database
			AUDIT_DB: D1Database
			BUNDLE_ARTIFACTS_KV: KVNamespace
			OAUTH_KV: KVNamespace
		}>()
		await worker.applyD1Migrations('APP_DB')
		await worker.applyD1Migrations('AUDIT_DB')
		await harness.getWorker('kody-jobs-test').applyD1Migrations('JOBS_DB')
		const env = await worker.getEnv()
		return {
			origin: url.origin,
			// Seed before /auth. These workers point CLOUDFLARE_API_* at the
			// mock so package publish can snapshot sources; a configured
			// sender then tries to deliver the verification email. The mock
			// Email DO can still 503 / return an empty body after /__mocks/meta
			// looks ready, and signup rolls the user back.
			async ensureUser(user: TestUser) {
				await seedMcpTestUser(env.APP_DB, user)
			},
			async markEmailVerified(email: string) {
				await env.APP_DB.prepare(
					`UPDATE users
SET email_verified_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE email = ?`,
				)
					.bind(email)
					.run()
			},
			async assignRole(email: string, role: string) {
				await env.APP_DB.prepare(
					`INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ? AND r.name = ?`,
				)
					.bind(email, role)
					.run()
			},
			async seedOAuthClient(
				clientId: string,
				registration: Record<string, unknown> | null,
			) {
				const key = `client:${clientId}`
				if (registration === null) await env.OAUTH_KV.delete(key)
				else await env.OAUTH_KV.put(key, JSON.stringify(registration))
			},
			async seedHeroVideos(videos: Array<LandingHeroVideo>) {
				await createKvCachifiedCache(env.BUNDLE_ARTIFACTS_KV).set(
					buildLandingHeroVideosCacheKey(landingHeroSourcePlaylistId),
					{
						value: videos,
						metadata: { createdTime: Date.now(), ttl: 300_000, swr: 3_600_000 },
					},
				)
			},
			async clearAuthRateLimits() {
				await env.APP_DB.prepare(
					`CREATE TABLE IF NOT EXISTS _rate_limits (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	key TEXT NOT NULL,
	ts INTEGER NOT NULL
)`,
				).run()
				await env.APP_DB.prepare(
					`DELETE FROM _rate_limits WHERE key LIKE 'auth:ip:%'`,
				).run()
			},
			async close() {
				try {
					await harness.close()
				} finally {
					try {
						await cloudflareMock[Symbol.asyncDispose]()
					} finally {
						await compiled.close()
					}
				}
			},
		}
	} catch (error) {
		await harness.close().catch(() => undefined)
		try {
			await cloudflareMock[Symbol.asyncDispose]()
		} finally {
			await compiled.close()
		}
		throw error
	}
}

export async function seedMcpTestUser(db: D1Database, user: TestUser) {
	const passwordHash = await createPasswordHash(user.password)
	await db
		.prepare(
			`INSERT INTO users (
	username, email, password_hash, email_verified_at, stable_user_id, personal_org_id
)
VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
ON CONFLICT(email) DO UPDATE SET
	username = excluded.username,
	password_hash = excluded.password_hash,
	email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at),
	stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
	personal_org_id = COALESCE(NULLIF(TRIM(users.personal_org_id), ''), excluded.personal_org_id),
	updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			user.username,
			user.email,
			passwordHash,
			seedStableUserIdFromEmail(user.email),
			seedStableUserIdFromEmail(user.email),
		)
		.run()
	await db
		.prepare(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id)
SELECT u.id, r.id
FROM users u, roles r
WHERE u.email = ? AND r.name = 'user'`,
		)
		.bind(user.email)
		.run()
	const personalOrgSql = buildSeedPersonalOrgSql({
		stableUserId: seedStableUserIdFromEmail(user.email),
		username: user.username,
	})
	for (const statement of personalOrgSql.split(';')) {
		const sql = statement.trim()
		if (!sql) continue
		await db.prepare(sql).run()
	}
}

/**
 * Browser session cookie for authenticated app-origin fetches
 * (`Cookie: kody_session=…`). Same JSON `/auth` signup-or-login path used by
 * MCP OAuth setup; safe to call again after `createMcpClient`.
 */
export async function createAppSessionCookie(origin: string, user: TestUser) {
	return loginToApp(origin, user)
}

export async function createMcpClient(
	origin: string,
	user: TestUser,
	options: {
		extraHeaders?: Record<string, string>
		ensureUser?: (user: TestUser) => Promise<void>
		// `/mcp` rejects unverified accounts, so the test user's email is
		// marked verified before connecting.
		markEmailVerified: (email: string) => Promise<void>
		clearAuthRateLimits?: () => Promise<void>
	},
) {
	const extraHeaders = options.extraHeaders
	if (options.clearAuthRateLimits) {
		await options.clearAuthRateLimits()
	}
	if (options.ensureUser) {
		await options.ensureUser(user)
	}
	const cookieHeader = await loginToApp(origin, user)
	await options.markEmailVerified(user.email)
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const defaultHeaders: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
	}

	const defaultConnection = await connectMcpClient(origin, {
		...defaultHeaders,
		...extraHeaders,
	})

	const client: ConnectedTestClient = {
		listTools() {
			return defaultConnection.client.listTools()
		},
		async callTool(params) {
			const { headers, ...callToolParams } = params
			if (!headers || Object.keys(headers).length === 0) {
				return defaultConnection.client.callTool(callToolParams)
			}

			const overrideConnection = await connectMcpClient(origin, {
				...defaultHeaders,
				...extraHeaders,
				...headers,
			})
			try {
				return await overrideConnection.client.callTool(callToolParams)
			} finally {
				await closeMcpConnection(overrideConnection)
			}
		},
	}

	return {
		client,
		async [Symbol.asyncDispose]() {
			await closeMcpConnection(defaultConnection)
		},
	}
}

/**
 * Modern-era MCP client (protocol revision 2026-07-28) from the SDK v2
 * client package, pinned so the connection fails loudly unless the server
 * serves the stateless lane. Reuses the same signup + OAuth plumbing as
 * `createMcpClient`.
 */
export async function createModernMcpClient(
	origin: string,
	user: TestUser,
	options: {
		ensureUser?: (user: TestUser) => Promise<void>
		markEmailVerified: (email: string) => Promise<void>
		clearAuthRateLimits?: () => Promise<void>
	},
) {
	if (options.clearAuthRateLimits) {
		await options.clearAuthRateLimits()
	}
	if (options.ensureUser) {
		await options.ensureUser(user)
	}
	const cookieHeader = await loginToApp(origin, user)
	await options.markEmailVerified(user.email)
	const clientRegistration = await registerOAuthClient(origin)
	const code = await authorizeOAuthClient(
		origin,
		clientRegistration,
		cookieHeader,
	)
	const accessToken = await exchangeAuthorizationCode(
		origin,
		clientRegistration,
		code,
	)
	const connection = await connectStatelessMcpClient(
		origin,
		{ Authorization: `Bearer ${accessToken}` },
		{ name: 'kody-mcp-e2e-modern-client' },
	)
	return {
		client: connection.client,
		async [Symbol.asyncDispose]() {
			await connection.client.close().catch(() => undefined)
			await connection.transport.close().catch(() => undefined)
		},
	}
}
