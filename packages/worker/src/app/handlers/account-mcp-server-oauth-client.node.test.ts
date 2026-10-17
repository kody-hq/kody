import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	decryptMcpServerOAuthClientSecret,
	mcpServerOAuthClientSecretContext,
} from '#mcp/secrets/crypto.ts'
import type * as HubClient from '#worker/mcp-client/hub-client.ts'
import { type SealedMcpPreRegisteredOAuthClient } from '#worker/mcp-client/preregistered-oauth-client.ts'
import { type McpServerOAuthClientChange } from '#worker/mcp-client/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createAuditTestDb } from '#worker/test-support/create-audit-db.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

type HubClientInput = {
	ownerId: string
	serverId: string
	callbackUrl: string
	client: SealedMcpPreRegisteredOAuthClient | null
}

const mocks = vi.hoisted(() => {
	const clientIds = new Map<string, string>()
	const connection = (serverId: string, pending: boolean) => ({
		serverId,
		state: pending ? ('authenticating' as const) : ('failed' as const),
		authorizationPending: pending,
		error: null,
		toolCount: 0,
		lastError: null,
	})
	return {
		clientIds,
		snapshotFails: false,
		setPreRegisteredOAuthClient: vi.fn<
			(input: HubClientInput) => Promise<McpServerOAuthClientChange>
		>(async (input) => {
			const previousClientId = clientIds.get(input.serverId) ?? null
			if (!input.client && !previousClientId) {
				return {
					changed: false,
					previousClientId,
					connection: connection(input.serverId, false),
				}
			}
			if (input.client) clientIds.set(input.serverId, input.client.clientId)
			else clientIds.delete(input.serverId)
			return {
				changed: true,
				previousClientId,
				connection: connection(input.serverId, true),
			}
		}),
	}
})

vi.mock('#worker/mcp-client/hub-client.ts', async (importOriginal) => ({
	...(await importOriginal<typeof HubClient>()),
	createMcpClientHubClient: (input: { userId: string }) => ({
		setPreRegisteredOAuthClient: (
			clientInput: Omit<HubClientInput, 'ownerId'>,
		) =>
			mocks.setPreRegisteredOAuthClient({
				ownerId: input.userId,
				...clientInput,
			}),
	}),
	getCachedMcpClientHubReadSnapshot: async () => {
		if (mocks.snapshotFails) throw new Error('hub snapshot unavailable')
		return {
			servers: [...mocks.clientIds].map(([serverId, oauthClientId]) => ({
				serverId,
				name: 'github',
				url: 'https://api.github.example/mcp',
				state: 'authenticating',
				authorizationPending: true,
				error: null,
				instructions: null,
				tools: [],
				oauthClientId,
			})),
		}
	},
}))

const { testAccountMcpServersApiHandler } =
	await import('./account-mcp-servers.test-support.ts')

const cookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const secretStoreKey = 'test-secret-store-key-32-chars-minimum'
const origin = 'https://kody.test'
const clientId = 'Iv1.github-app-client'
const clientSecret = 'gh-oauth-client-secret-never-echo'
const replacementSecret = 'gh-oauth-client-secret-rotated'

const people = {
	ada: { id: 1, email: 'ada@example.com' },
	bob: { id: 2, email: 'bob@example.com' },
	dan: { id: 3, email: 'dan@example.com' },
} as const
type Person = keyof typeof people

function personId(person: Person) {
	return testStableUserIdFromEmail(people[person].email)
}

const consoleCalls: Array<unknown> = []
beforeEach(() => {
	consoleCalls.length = 0
	for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
		vi.spyOn(console, method).mockImplementation((...args) => {
			consoleCalls.push(args)
		})
	}
})
afterEach(() => {
	vi.restoreAllMocks()
})

async function seed() {
	setAuthSessionSecret(cookieSecret)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const passwordHash = await createPasswordHash('test-password')
	for (const [username, person] of Object.entries(people)) {
		sqlite.exec(`
			INSERT INTO users (
				id, username, email, stable_user_id, password_hash, email_verified_at
			) VALUES (
				${person.id},
				${quoteSqlString(username)},
				${quoteSqlString(person.email)},
				${quoteSqlString(testStableUserIdFromEmail(person.email))},
				${quoteSqlString(passwordHash)},
				CURRENT_TIMESTAMP
			);
		`)
		await provisionPersonalOrgForSqliteUser(sqlite, {
			stableUserId: testStableUserIdFromEmail(person.email),
			username,
		})
	}
	const now = '2026-01-01T00:00:00.000Z'
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_by_user_id, created_at, updated_at)
			 VALUES ('org-acme', 'acme', 'Acme', ?, ?, ?)`,
		)
		.run(personId('ada'), now, now)
	for (const [person, role] of [
		['ada', 'owner'],
		['dan', 'member'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(personId(person), role, now)
	}
	sqlite
		.prepare(
			`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES (?, ?, ?, ?)`,
		)
		.run('server-acme', 'org-acme', 'github', 'https://api.github.example/mcp')
	mocks.setPreRegisteredOAuthClient.mockClear()
	mocks.clientIds.clear()
	mocks.snapshotFails = false
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		AUDIT_DB: createAuditTestDb(),
		APP_BASE_URL: origin,
		COOKIE_SECRET: cookieSecret,
		SECRET_STORE_KEY: secretStoreKey,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
	return { env, sqlite }
}

async function callApi(
	env: Env,
	input: {
		person: Person
		orgSlug?: string
		method?: 'GET' | 'POST'
		body?: Record<string, unknown>
	},
) {
	const orgSlug = input.orgSlug ?? 'acme'
	const cookie = await createAuthCookie(
		{
			stableUserId: personId(input.person),
			email: people[input.person].email,
			rememberMe: false,
		},
		false,
	)
	const request = new Request(
		`${origin}/@${orgSlug}/-/mcp-servers/server-acme`,
		{
			method: input.method ?? 'POST',
			headers: {
				Cookie: cookie,
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Origin: origin,
			},
			...(input.body ? { body: JSON.stringify(input.body) } : {}),
		},
	)
	const response = await testAccountMcpServersApiHandler(env).execute({
		request,
		params: {},
		url: new URL(request.url),
	} as never)
	return { status: response.status, text: JSON.stringify(response.data) }
}

function storedSetting(sqlite: DatabaseSync) {
	return sqlite
		.prepare(`SELECT * FROM mcp_server_settings WHERE id = 'server-acme'`)
		.get() as Record<string, unknown>
}

async function auditRows(env: Env) {
	const { results } = await env.AUDIT_DB.prepare(
		`SELECT * FROM org_audit_events ORDER BY created_at, rowid`,
	).all<Record<string, unknown>>()
	return results ?? []
}

function hubCall(index: number) {
	const call = mocks.setPreRegisteredOAuthClient.mock.calls[index]?.[0]
	if (!call) throw new Error(`Expected hub call ${index}.`)
	return call
}

test('an org admin saves, replaces, and removes a client; only the sealed secret reaches the hub and nothing echoes it', async () => {
	const { env, sqlite } = await seed()

	const saved = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId: ` ${clientId} `,
			clientSecret,
		},
	})
	expect(saved.status).toBe(200)
	expect(saved.text).not.toContain(clientSecret)
	expect(JSON.parse(saved.text)).toMatchObject({
		ok: true,
		selectedServerId: 'server-acme',
		oauthClientId: clientId,
	})

	const firstCall = hubCall(0)
	expect(firstCall).toMatchObject({
		ownerId: 'org-acme',
		serverId: 'server-acme',
		callbackUrl: `${origin}/account/mcp-servers/oauth/callback`,
		client: { clientId, sealedClientSecret: expect.stringMatching(/^v2\./) },
	})
	expect(JSON.stringify(firstCall)).not.toContain(clientSecret)
	const sealed = firstCall.client?.sealedClientSecret ?? ''
	expect(
		await decryptMcpServerOAuthClientSecret(
			env,
			sealed,
			mcpServerOAuthClientSecretContext('server-acme'),
		),
	).toBe(clientSecret)
	await expect(
		decryptMcpServerOAuthClientSecret(
			env,
			sealed,
			mcpServerOAuthClientSecretContext('server-other'),
		),
	).rejects.toThrow('Unable to decrypt MCP server OAuth client secret.')

	expect(mocks.clientIds.get('server-acme')).toBe(clientId)
	expect(JSON.stringify(storedSetting(sqlite))).not.toContain(clientSecret)

	const listed = await callApi(env, { person: 'ada', method: 'GET' })
	expect(listed.status).toBe(200)
	expect(listed.text).toContain(clientId)
	expect(listed.text).not.toContain(clientSecret)

	const replaced = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId,
			clientSecret: replacementSecret,
		},
	})
	expect(replaced.status).toBe(200)
	expect(replaced.text).not.toContain(replacementSecret)

	const removed = await callApi(env, {
		person: 'ada',
		body: { action: 'remove-oauth-client', id: 'server-acme' },
	})
	expect(removed.status).toBe(200)
	expect(hubCall(2).client).toBeNull()
	expect(mocks.clientIds.has('server-acme')).toBe(false)

	const audit = await auditRows(env)
	expect(
		audit.map((row) => ({
			org: row['org_id'],
			action: row['action'],
			resourceType: row['resource_type'],
			resourceId: row['resource_id'],
			actor: row['actor_user_id'],
			details: JSON.parse(String(row['details_json'])),
		})),
	).toEqual([
		{
			org: 'org-acme',
			action: 'mcp_server.oauth_client_set',
			resourceType: 'mcp_server',
			resourceId: 'server-acme',
			actor: personId('ada'),
			details: { serverName: 'github', clientId },
		},
		{
			org: 'org-acme',
			action: 'mcp_server.oauth_client_replaced',
			resourceType: 'mcp_server',
			resourceId: 'server-acme',
			actor: personId('ada'),
			details: { serverName: 'github', clientId },
		},
		{
			org: 'org-acme',
			action: 'mcp_server.oauth_client_removed',
			resourceType: 'mcp_server',
			resourceId: 'server-acme',
			actor: personId('ada'),
			details: { serverName: 'github', clientId },
		},
	])

	const everything = JSON.stringify([
		audit,
		consoleCalls,
		mocks.setPreRegisteredOAuthClient.mock.calls,
		storedSetting(sqlite),
	])
	expect(everything).not.toContain(clientSecret)
	expect(everything).not.toContain(replacementSecret)
})

test('members without integration write, people outside the org, and other orgs cannot touch the client', async () => {
	const { env } = await seed()
	const body = {
		action: 'set-oauth-client',
		id: 'server-acme',
		clientId,
		clientSecret,
	}

	const member = await callApi(env, { person: 'dan', body })
	expect(member.status).toBe(403)

	const outsider = await callApi(env, { person: 'bob', body })
	expect(outsider.status).toBe(400)
	expect(JSON.parse(outsider.text)).toMatchObject({
		ok: false,
		error: 'MCP server not found.',
	})

	const wrongOrg = await callApi(env, { person: 'ada', orgSlug: 'ada', body })
	expect(wrongOrg.status).toBe(400)
	expect(JSON.parse(wrongOrg.text)).toMatchObject({
		ok: false,
		error: 'MCP server not found.',
	})

	const memberRemove = await callApi(env, {
		person: 'dan',
		body: { action: 'remove-oauth-client', id: 'server-acme' },
	})
	expect(memberRemove.status).toBe(403)

	expect(mocks.setPreRegisteredOAuthClient).not.toHaveBeenCalled()
	expect(mocks.clientIds.size).toBe(0)
	expect(await auditRows(env)).toEqual([])
	for (const response of [member, outsider, wrongOrg, memberRemove]) {
		expect(response.text).not.toContain(clientSecret)
	}
	expect(JSON.stringify(consoleCalls)).not.toContain(clientSecret)
})

test('incomplete input and removing a missing client are rejected and write nothing', async () => {
	const { env } = await seed()

	const missingSecret = await callApi(env, {
		person: 'ada',
		body: { action: 'set-oauth-client', id: 'server-acme', clientId },
	})
	expect(missingSecret.status).toBe(400)
	expect(JSON.parse(missingSecret.text)).toMatchObject({
		ok: false,
		error: 'Client secret is required.',
	})

	const nothingToRemove = await callApi(env, {
		person: 'ada',
		body: { action: 'remove-oauth-client', id: 'server-acme' },
	})
	expect(nothingToRemove.status).toBe(400)
	expect(JSON.parse(nothingToRemove.text)).toMatchObject({
		ok: false,
		error: 'This server has no OAuth client configured.',
	})

	expect(mocks.setPreRegisteredOAuthClient).toHaveBeenCalledTimes(1)
	expect(hubCall(0).client).toBeNull()
	expect(mocks.clientIds.size).toBe(0)
	expect(await auditRows(env)).toEqual([])
})

test('a hub failure reports the error and records no audit event', async () => {
	const { env } = await seed()
	mocks.setPreRegisteredOAuthClient.mockRejectedValueOnce(
		new Error('MCP server "server-acme" is not registered.'),
	)

	const failed = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId,
			clientSecret,
		},
	})
	expect(failed.status).toBe(400)
	expect(failed.text).toContain('Unable to update the OAuth client')
	expect(failed.text).not.toContain(clientSecret)
	expect(mocks.clientIds.size).toBe(0)
	expect(await auditRows(env)).toEqual([])
})

test('the save response shows the hub reply even when the snapshot read fails', async () => {
	const { env } = await seed()
	mocks.snapshotFails = true
	consoleCalls.length = 0

	const saved = await callApi(env, {
		person: 'ada',
		body: {
			action: 'set-oauth-client',
			id: 'server-acme',
			clientId,
			clientSecret,
		},
	})
	expect(saved.status).toBe(200)
	expect(JSON.parse(saved.text)).toMatchObject({
		ok: true,
		selectedServerId: 'server-acme',
		oauthClientId: clientId,
	})
	expect(JSON.parse(saved.text)).not.toHaveProperty('servers')
	expect(saved.text).not.toContain(clientSecret)
	expect(JSON.stringify(consoleCalls)).not.toContain(clientSecret)
})
