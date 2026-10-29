/**
 * createAuthenticatedFetch(name) reads config through the host-side runtime
 * tool: run-org connection by name first, else the actor's own personal
 * connection granted to the run org, the set the token gateway resolves.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	ownerIdFromStored,
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { grantPersonalCredentialToOrg } from '#worker/credentials/personal-credentials.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { IntegrationPackageAccessDeniedError } from '#worker/integrations/package-access.ts'
import {
	createAuthenticatedFetch,
	INTEGRATION_RUNTIME_CONFIG_TOOL_NAME,
	type KodyNamespace,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import {
	encryptUserOauthAccessToken,
	encryptUserOauthRefreshToken,
	userIntegrationCredentialContext,
} from '#mcp/secrets/crypto.ts'
import { integrationGetCapability } from './integration-get.ts'
import { readIntegrationRuntimeConfig } from './integration-runtime-config.ts'

const scheduledAudits = vi.hoisted(() => [] as Array<Promise<unknown>>)

vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	waitUntil: (promise: Promise<unknown>) => {
		scheduledAudits.push(promise)
	},
}))

const now = '2026-10-29T00:00:00.000Z'
const usernames = ['ann', 'bea', 'cal'] as const
type Username = (typeof usernames)[number]

async function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	const db = createD1FromSqlite(sqlite)
	const env = {
		APP_DB: db,
		AUDIT_DB: createAuditTestDb(),
		...createInMemoryUserMeterEnv().env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	const people = Object.fromEntries(
		usernames.map((username) => {
			const stableUserId = testStableUserIdFromEmail(`${username}@example.com`)
			return [
				username,
				{ stableUserId, personId: personIdFromStored(stableUserId) },
			]
		}),
	) as Record<
		Username,
		{ stableUserId: string; personId: ReturnType<typeof personIdFromStored> }
	>
	for (const [username, person] of Object.entries(people)) {
		await provisionPersonalOrg(db, {
			stableUserId: person.stableUserId,
			username,
			createdAt: now,
		})
	}
	const created = await createOrganization(
		db,
		{} as Pick<Env, 'BUNDLE_ARTIFACTS_KV'>,
		{
			personId: people.bea.personId,
			audit: createTestOrgAuditWriter(),
			slug: 'acme-fetch',
			displayName: 'Acme',
		},
	)
	if (!created.ok) throw new Error(created.error)
	const acme = await db
		.prepare(`SELECT id FROM orgs WHERE slug = 'acme-fetch'`)
		.first<{ id: string }>()
	const acmeId = ownerIdFromStored(acme!.id)
	for (const member of ['ann', 'cal'] as const) {
		await db
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'member', ?)`,
			)
			.bind(acmeId, people[member].stableUserId, now)
			.run()
	}

	async function saveConnection(input: {
		ownerId: OwnerId
		apiBaseUrl: string
		accessToken: string
	}) {
		await db
			.prepare(
				`INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow)
				 VALUES (?, 'svc', 'svc', 'fixture-client-id', 'https://auth.example.com/token', ?, 'pkce')`,
			)
			.bind(input.ownerId, input.apiBaseUrl)
			.run()
		const host = new URL(input.apiBaseUrl).hostname
		const context = userIntegrationCredentialContext(input.ownerId, 'svc')
		await db
			.prepare(
				`INSERT INTO user_integrations (user_id, name, app_slug, required_hosts_json, access_token_encrypted, refresh_token_encrypted, connected_at)
				 VALUES (?, 'svc', 'svc', ?, ?, ?, ?)`,
			)
			.bind(
				input.ownerId,
				JSON.stringify([host, 'auth.example.com']),
				await encryptUserOauthAccessToken(env, input.accessToken, context),
				await encryptUserOauthRefreshToken(
					env,
					`${input.accessToken}-refresh`,
					context,
				),
				now,
			)
			.run()
		return (await db
			.prepare(
				`SELECT id FROM user_integrations WHERE user_id = ? AND name = 'svc'`,
			)
			.bind(input.ownerId)
			.first<{ id: string }>())!.id
	}

	async function savePersonalConnection(person: Username) {
		const ownerId = personalOrgId(people[person].personId)
		const credentialId = await saveConnection({
			ownerId,
			apiBaseUrl: `https://${person}.example.com`,
			accessToken: `${person}-personal-token`,
		})
		return {
			credentialId,
			grant: () =>
				grantPersonalCredentialToOrg({
					db,
					ownerPersonId: people[person].personId,
					credentialId,
					orgId: acmeId,
				}),
		}
	}

	const callerAs = (
		person: Username,
		role: 'owner' | 'member',
		source: Parameters<typeof createMcpCallerContext>[0]['source'] = {
			kind: 'mcp-oauth',
		},
		scopes?: Parameters<typeof createMcpCallerContext>[0]['scopes'],
	) =>
		createMcpCallerContext({
			source,
			scopes,
			baseUrl: 'https://example.com',
			user: {
				userId: people[person].personId,
				email: `${person}@example.com`,
				displayName: person,
			},
			orgBinding: { org: { id: acmeId, slug: 'acme-fetch' }, role },
		})

	const readConfig = (
		callerContext: ReturnType<typeof callerAs>,
		name = 'svc',
	) =>
		readIntegrationRuntimeConfig({
			env,
			callerContext,
			integrationGet: integrationGetCapability,
			args: { name },
		})

	/** The sandbox helper wired to the host tool and the token gateway. */
	async function fetchAs(
		callerContext: ReturnType<typeof callerAs>,
		options: { rejectToken?: string } = {},
	) {
		const kody = {
			[INTEGRATION_RUNTIME_CONFIG_TOOL_NAME]: (args) =>
				readIntegrationRuntimeConfig({
					env,
					callerContext,
					integrationGet: integrationGetCapability,
					args,
				}),
			async integrationTokenRefresh(args) {
				const result = await resolveCredential({
					env,
					orgId: acmeId,
					actor: callerContext.request ?? null,
					baseUrl: 'https://example.com',
					credential: { use: 'integration-refresh', name: String(args.name) },
				})
				return { ok: true, refreshed: result.refreshed }
			},
		} satisfies KodyNamespace
		const gateway: typeof fetch = async (input, init) => {
			const request = new Request(input, init)
			const url = new URL(request.url)
			const header = request.headers.get('authorization')
			expect(header).toBe('Bearer {{integration-token:svc}}')
			const token = await resolveCredential({
				env,
				orgId: acmeId,
				actor: callerContext.request ?? null,
				baseUrl: 'https://example.com',
				credential: {
					use: 'integration-token',
					name: 'svc',
					requestHost: url.hostname,
				},
			})
			if (token === options.rejectToken) {
				return new Response('expired', { status: 401 })
			}
			return Response.json({ host: url.hostname, token })
		}
		const authed = await createAuthenticatedFetch(kody, 'svc', {
			fetch: gateway,
		})
		return (await (await authed('/me')).json()) as {
			host: string
			token: string
		}
	}

	scheduledAudits.length = 0
	return {
		db,
		env,
		acmeId,
		saveConnection,
		savePersonalConnection,
		callerAs,
		readConfig,
		fetchAs,
	}
}

const notFound = 'Integration "svc" was not found.'

async function settle<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error: (error as Error).message }),
	)
}

test('a personal connection granted to the run org resolves and fetches', async () => {
	const t = await setup()
	const ann = await t.savePersonalConnection('ann')
	await ann.grant()

	await expect(t.readConfig(t.callerAs('ann', 'member'))).resolves.toEqual({
		integration: {
			name: 'svc',
			apiBaseUrl: 'https://ann.example.com',
			requiredHosts: ['ann.example.com', 'auth.example.com'],
		},
	})
	await expect(t.fetchAs(t.callerAs('ann', 'member'))).resolves.toEqual({
		host: 'ann.example.com',
		token: 'ann-personal-token',
	})
})

test('only non-secret config reaches the sandbox', async () => {
	const t = await setup()
	await (await t.savePersonalConnection('ann')).grant()
	const result = await t.readConfig(t.callerAs('ann', 'member'))
	expect(Object.keys(result.integration ?? {}).sort()).toEqual([
		'apiBaseUrl',
		'name',
		'requiredHosts',
	])
	expect(JSON.stringify(result)).not.toContain('token')
	expect(JSON.stringify(result)).not.toContain('fixture-client-id')
})

test('a personal connection not granted to the run org answers like integrationGet', async () => {
	const t = await setup()
	await t.savePersonalConnection('ann')
	const ann = t.callerAs('ann', 'member')

	const publicRead = await settle(
		integrationGetCapability.handler(
			{ name: 'svc' },
			{ env: t.env, callerContext: ann },
		),
	)
	expect(await settle(t.readConfig(ann))).toEqual(publicRead)
	await expect(t.fetchAs(ann)).rejects.toThrow(
		'value' in publicRead ? notFound : publicRead.error,
	)
})

test("another member's granted personal connection is never used", async () => {
	const t = await setup()
	await (await t.savePersonalConnection('cal')).grant()
	const ann = t.callerAs('ann', 'member')

	const publicRead = await settle(
		integrationGetCapability.handler(
			{ name: 'svc' },
			{ env: t.env, callerContext: ann },
		),
	)
	expect(await settle(t.readConfig(ann))).toEqual(publicRead)
	await expect(t.fetchAs(ann)).rejects.toThrow()
})

test("Owner and Automation runs cannot use a member's personal connection", async () => {
	const t = await setup()
	await (await t.savePersonalConnection('ann')).grant()

	await expect(t.readConfig(t.callerAs('bea', 'owner'))).resolves.toEqual({
		integration: null,
	})
	await expect(t.fetchAs(t.callerAs('bea', 'owner'))).rejects.toThrow(notFound)

	// An Automation run enabled by Ann still has no acting person.
	const automation = t.callerAs('ann', 'member', {
		kind: 'schedule',
		jobId: 'job-fixture',
	})
	expect(automation.request?.actor).toBeNull()
	const publicRead = await settle(
		integrationGetCapability.handler(
			{ name: 'svc' },
			{ env: t.env, callerContext: automation },
		),
	)
	expect(await settle(t.readConfig(automation))).toEqual(publicRead)
	await expect(t.fetchAs(automation)).rejects.toThrow()
})

test('a 401 on a granted personal connection refreshes host-side and retries', async () => {
	const t = await setup()
	await (await t.savePersonalConnection('ann')).grant()
	const tokenRequests: Array<string> = []
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init)
			if (request.url !== 'https://auth.example.com/token') {
				return realFetch(input, init)
			}
			tokenRequests.push(
				new URLSearchParams(await request.text()).get('refresh_token') ?? '',
			)
			return Response.json({
				access_token: 'ann-refreshed-token',
				token_type: 'Bearer',
				expires_in: 3600,
			})
		},
	)
	try {
		await expect(
			t.fetchAs(t.callerAs('ann', 'member'), {
				rejectToken: 'ann-personal-token',
			}),
		).resolves.toEqual({
			host: 'ann.example.com',
			token: 'ann-refreshed-token',
		})
	} finally {
		vi.unstubAllGlobals()
	}
	expect(tokenRequests).toEqual(['ann-personal-token-refresh'])
})

test('a token without integration:use cannot reach a granted personal connection', async () => {
	const t = await setup()
	await (await t.savePersonalConnection('ann')).grant()
	const scoped = t.callerAs('ann', 'member', { kind: 'mcp-oauth' }, [
		'package:read',
	])

	expect(await settle(t.readConfig(scoped))).not.toMatchObject({
		value: { integration: { apiBaseUrl: 'https://ann.example.com' } },
	})
	await expect(t.fetchAs(scoped)).rejects.toThrow()
})

test("the package allowlist on the owner's personal org still applies", async () => {
	const t = await setup()
	const ann = await t.savePersonalConnection('ann')
	await ann.grant()
	await t.db
		.prepare(
			`UPDATE user_integrations SET usage_mode = 'packages', allowed_packages_json = '[]' WHERE id = ?`,
		)
		.bind(ann.credentialId)
		.run()

	await expect(t.readConfig(t.callerAs('ann', 'member'))).rejects.toThrow(
		IntegrationPackageAccessDeniedError,
	)
})

test('an org connection of the same name wins over a personal one', async () => {
	const t = await setup()
	await (await t.savePersonalConnection('ann')).grant()
	await t.saveConnection({
		ownerId: t.acmeId,
		apiBaseUrl: 'https://org.example.com',
		accessToken: 'org-token',
	})

	await expect(t.readConfig(t.callerAs('bea', 'owner'))).resolves.toEqual({
		integration: {
			name: 'svc',
			apiBaseUrl: 'https://org.example.com',
			requiredHosts: ['auth.example.com', 'org.example.com'],
		},
	})
	await expect(t.fetchAs(t.callerAs('bea', 'owner'))).resolves.toEqual({
		host: 'org.example.com',
		token: 'org-token',
	})
})

test('public integrationGet stays run-org only', async () => {
	const t = await setup()
	await (await t.savePersonalConnection('ann')).grant()
	const callerContext = t.callerAs('ann', 'member')

	const result = await integrationGetCapability
		.handler({ name: 'svc' }, { env: t.env, callerContext })
		.catch(() => ({ integration: null }))
	expect(result).toEqual({ integration: null })
	// The runtime read still finds Ann's granted connection.
	await expect(t.readConfig(callerContext)).resolves.toMatchObject({
		integration: { apiBaseUrl: 'https://ann.example.com' },
	})
})
