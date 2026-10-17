import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { testAccountConnectedAgentsApiHandler } from '#app/handlers/account-connected-agents.test-support.ts'
import {
	listInboundMcpConnectionLastUsed,
	recordInboundMcpConnectionLastUsed,
} from '#worker/inbound-mcp-connection-last-used.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

const userOneSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('one@example.com'),
	email: 'one@example.com',
	rememberMe: false,
}

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

function createAppEnv(
	helpers?: {
		listUserGrants: ReturnType<typeof vi.fn>
		revokeGrant: ReturnType<typeof vi.fn>
		lookupClient?: ReturnType<typeof vi.fn>
	},
	meter = createInMemoryUserMeterEnv(),
	appDb: D1Database = {} as D1Database,
) {
	return {
		APP_DB: appDb,
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
		OAUTH_PROVIDER: helpers,
		...meter.env,
	} as unknown as Env
}

test('connected agents API lists unique inbound clients and revokes every grant for one clientId', async () => {
	setAuthSessionSecret(testCookieSecret)
	const grants = [
		{
			id: 'grant-1',
			clientId: 'client-a',
			scope: ['profile'],
			createdAt: 1_700_000_000,
		},
		{
			id: 'grant-2',
			clientId: 'client-a',
			scope: ['profile'],
			createdAt: 1_700_000_100,
		},
		{
			id: 'grant-3',
			clientId: 'https://chatgpt.com/oauth/vG3/client.json',
			scope: ['profile'],
			redirectUri: 'https://chatgpt.com/connector/oauth/vG3',
			createdAt: 1_700_000_200,
		},
	]
	const helpers = {
		listUserGrants: vi.fn(async () => ({
			items: grants.filter((grant) => grant.id !== 'revoked'),
		})),
		revokeGrant: vi.fn(async (grantId: string) => {
			const index = grants.findIndex((grant) => grant.id === grantId)
			if (index >= 0) grants.splice(index, 1)
		}),
		lookupClient: vi.fn(async (clientId: string) => {
			if (clientId === 'client-a') {
				return { clientId, clientName: 'Cursor' }
			}
			return { clientId, clientName: 'ChatGPT' }
		}),
	}
	const signIn = (emailVerified: boolean) =>
		mockModule.readAuthenticatedAppUser.mockResolvedValue({
			email: userOneSession.email,
			emailVerified,
			mcpUser: { userId: userOneSession.stableUserId },
		})
	signIn(true)
	const cookie = await createAuthCookie(userOneSession, false)
	const meter = createInMemoryUserMeterEnv()
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	// The two known ecosystems make this person eligible, but GET must not
	// grant the entitlement. OAuth completion and reconciliation own that write.
	sqlite
		.prepare(`INSERT INTO users (username, email, password_hash, stable_user_id)
		VALUES ('one', 'one@example.com', 'hash', ?)`)
		.run(userOneSession.stableUserId)
	await provisionPersonalOrg(createD1FromSqlite(sqlite), {
		stableUserId: userOneSession.stableUserId,
		username: 'one',
		createdAt: new Date().toISOString(),
	})

	const insertSubscription = sqlite.prepare(
		`INSERT INTO mcp_event_subscriptions (
			id, user_id, oauth_client_id, event_name, arguments_json,
			callback_url, secret_encrypted
		) VALUES (?, ?, ?, 'demo.ping', '{}', 'https://hooks.example.com/kody', 'x')`,
	)
	insertSubscription.run('sub_a', userOneSession.stableUserId, 'client-a')
	insertSubscription.run('sub_other_user', 'someone-else', 'client-a')
	insertSubscription.run(
		'sub_chatgpt',
		userOneSession.stableUserId,
		'https://chatgpt.com/oauth/vG3/client.json',
	)
	const { execute } = testAccountConnectedAgentsApiHandler(
		createAppEnv(helpers, meter, createD1FromSqlite(sqlite)),
	)
	const url = 'https://example.com/account/connected-agents.json'
	const request = (init: RequestInit = {}) => {
		const req = new Request(url, {
			...init,
			headers: { Cookie: cookie, Accept: 'application/json', ...init.headers },
		})
		return execute({ request: req, url: new URL(url), params: {} } as never)
	}
	const revoke = (clientId: string) =>
		request({
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ intent: 'revoke', clientId }),
		})

	const listed = await request()
	expect(listed.status).toBe(200)
	const listBody = listed.data as {
		ok: true
		agents: Array<{
			clientId: string
			label: string
			kind: string | null
			lastUsedAt: string | null
		}>
		mcpServerUrl: string
	}
	expect(listBody.ok).toBe(true)
	expect(
		sqlite
			.prepare(
				'SELECT second_agent_standard_gift_granted_at AS granted FROM orgs WHERE id = ?',
			)
			.get(userOneSession.stableUserId)?.granted,
	).toBeNull()

	expect(listBody.agents.map((agent) => agent.label)).toEqual([
		'ChatGPT.com',
		'Cursor',
	])
	expect(listBody.agents.map((agent) => agent.lastUsedAt)).toEqual([null, null])
	// The Connections page pastes this into a new host; it comes from the
	// request origin so preview and local deployments show their own URL.
	expect(listBody.mcpServerUrl).toBe('https://example.com/mcp')

	signIn(false)
	const unverified = await request()
	expect(unverified.status).toBe(200)
	// Same gate as the onboarding payload: no MCP URL until the email is
	// verified, so the page cannot push a user into the authorize → 403 loop.
	expect(unverified.data).toMatchObject({ mcpServerUrl: '' })
	signIn(true)

	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId: ownerIdFromStored(userOneSession.stableUserId),
		clientId: 'client-a',
		lastUsedAt: '2026-03-20T12:00:00.000Z',
		nowMs: Date.parse('2026-03-20T12:00:00.000Z'),
	})
	await recordInboundMcpConnectionLastUsed({
		env: meter.env,
		userId: ownerIdFromStored(userOneSession.stableUserId),
		clientId: 'https://chatgpt.com/oauth/vG3/client.json',
		lastUsedAt: '2026-03-10T12:00:00.000Z',
		nowMs: Date.parse('2026-03-10T12:00:00.000Z'),
	})
	const listedWithLastUsed = await request()
	expect(listedWithLastUsed.status).toBe(200)
	expect(
		(
			listedWithLastUsed.data as {
				ok: boolean
				agents: Array<{ clientId: string; lastUsedAt: string | null }>
			}
		).agents,
	).toEqual([
		{
			clientId: 'client-a',
			grantIds: ['grant-1', 'grant-2'],
			connectionProfileName: null,
			label: 'Cursor',
			kind: 'cursor',
			connectedAt: '2023-11-14T22:13:20.000Z',
			lastUsedAt: '2026-03-20T12:00:00.000Z',
		},
		{
			clientId: 'https://chatgpt.com/oauth/vG3/client.json',
			grantIds: ['grant-3'],
			connectionProfileName: null,
			label: 'ChatGPT.com',
			kind: 'chatgpt',
			connectedAt: '2023-11-14T22:16:40.000Z',
			lastUsedAt: '2026-03-10T12:00:00.000Z',
		},
	])

	const revoked = await revoke('client-a')
	expect(revoked.status).toBe(200)
	expect(helpers.revokeGrant).toHaveBeenCalledTimes(2)
	expect(revoked.data).toEqual({ ok: true })
	const revokeBody = (await request()).data as {
		ok: true
		agents: Array<{ clientId: string }>
	}
	expect(revokeBody.agents.map((agent) => agent.clientId)).toEqual([
		'https://chatgpt.com/oauth/vG3/client.json',
	])
	// Only this user's grant to client-a is gone; a shared client's other
	// users and this user's other clients keep their MCP event subscriptions.
	expect(
		sqlite
			.prepare(`SELECT id FROM mcp_event_subscriptions ORDER BY id`)
			.all()
			.map((row) => row['id']),
	).toEqual(['sub_chatgpt', 'sub_other_user'])
	expect(
		await listInboundMcpConnectionLastUsed({
			env: meter.env,
			userId: ownerIdFromStored(userOneSession.stableUserId),
		}),
	).toEqual(
		new Map([
			['https://chatgpt.com/oauth/vG3/client.json', '2026-03-10T12:00:00.000Z'],
		]),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'oauth',
			action: 'mcp_inbound_grant_revoke',
			result: 'success',
			clientId: 'client-a',
		}),
	)

	const missing = await revoke('missing')
	expect(missing.status).toBe(404)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await execute({
		request: new Request(url),
		url: new URL(url),
		params: {},
	} as never)
	expect(unauthorized.status).toBe(401)
})

test('connected agents API on a team org lists and revokes only agents approved for that org', async () => {
	setAuthSessionSecret(testCookieSecret)
	const personId = userOneSession.stableUserId
	const teamOrgId = 'org-acme'
	const grants: Array<{
		id: string
		clientId: string
		scope: Array<string>
		createdAt: number
		metadata?: unknown
	}> = [
		{
			id: 'grant-personal',
			clientId: 'client-a',
			scope: ['profile'],
			createdAt: 1_700_000_000,
		},
		{
			id: 'grant-team',
			clientId: 'client-a',
			scope: ['profile'],
			createdAt: 1_700_000_100,
			metadata: { orgId: teamOrgId },
		},
		{
			id: 'grant-chatgpt',
			clientId: 'client-b',
			scope: ['profile'],
			createdAt: 1_700_000_200,
			metadata: { orgId: personId },
		},
	]
	const helpers = {
		listUserGrants: vi.fn(async () => ({ items: [...grants] })),
		revokeGrant: vi.fn(async (grantId: string) => {
			const index = grants.findIndex((grant) => grant.id === grantId)
			if (index >= 0) grants.splice(index, 1)
		}),
		lookupClient: vi.fn(async (clientId: string) => ({
			clientId,
			clientName: clientId === 'client-a' ? 'Cursor' : 'ChatGPT',
		})),
	}
	const signInTo = (orgId: string) =>
		mockModule.readAuthenticatedAppUser.mockResolvedValue({
			email: userOneSession.email,
			emailVerified: true,
			mcpUser: { userId: personId },
			request: { org: { id: orgId, slug: 'acme' } },
		})
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	sqlite
		.prepare(
			`INSERT INTO mcp_event_subscriptions (
				id, user_id, oauth_client_id, event_name, arguments_json,
				callback_url, secret_encrypted
			) VALUES ('sub_a', ?, 'client-a', 'demo.ping', '{}', 'https://hooks.example.com/kody', 'x')`,
		)
		.run(personId)
	const { execute } = testAccountConnectedAgentsApiHandler(
		createAppEnv(helpers, undefined, createD1FromSqlite(sqlite)),
	)
	const url = 'https://example.com/account/connected-agents.json'
	const call = async (body?: unknown) => {
		const response = await execute({
			request: new Request(url, {
				method: body ? 'POST' : 'GET',
				headers: { 'Content-Type': 'application/json' },
				...(body ? { body: JSON.stringify(body) } : {}),
			}),
			url: new URL(url),
			params: {},
		} as never)
		return {
			status: response.status,
			body: response.data as {
				agents?: Array<{ clientId: string; grantIds: Array<string> }>
				connectionProfilesEnabled?: boolean
				error?: string
			},
		}
	}

	signInTo(teamOrgId)
	const team = await call()
	expect(team.status).toBe(200)
	expect(team.body.agents).toEqual([
		expect.objectContaining({ clientId: 'client-a', grantIds: ['grant-team'] }),
	])
	expect(team.body.connectionProfilesEnabled).toBe(false)

	const profileCreate = await call({ intent: 'create', name: 'work' })
	expect(profileCreate.status).toBe(404)

	const notInTeam = await call({ intent: 'revoke', clientId: 'client-b' })
	expect(notInTeam.status).toBe(404)
	expect(helpers.revokeGrant).not.toHaveBeenCalled()

	const revoked = await call({ intent: 'revoke', clientId: 'client-a' })
	expect(revoked.status).toBe(200)
	expect(helpers.revokeGrant).toHaveBeenCalledTimes(1)
	expect(helpers.revokeGrant).toHaveBeenCalledWith('grant-team', personId)
	expect(revoked.body).toEqual({ ok: true })
	expect((await call()).body.agents).toEqual([])
	// Cursor is still connected to the signup org, so its subscriptions stay.
	expect(
		sqlite
			.prepare(`SELECT id FROM mcp_event_subscriptions`)
			.all()
			.map((row) => row['id']),
	).toEqual(['sub_a'])

	signInTo(personId)
	const personal = await call()
	expect(personal.body.agents?.map((agent) => agent.grantIds)).toEqual([
		['grant-chatgpt'],
		['grant-personal'],
	])

	expect(helpers.revokeGrant).toHaveBeenCalledTimes(1)
})
