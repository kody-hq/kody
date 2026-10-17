import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { type McpServerAuthorizeContinueResponse } from '#universal/loader-data.ts'
import { type McpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { type McpServerPendingAuthorization } from '#worker/mcp-client/types.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readPendingAuthorization: vi.fn<
		(input: {
			ownerId: string
			serverId: string
		}) => Promise<McpServerPendingAuthorization | null>
	>(async () => null),
	bindOAuthAttemptActor: vi.fn(async (): Promise<{ ok: boolean }> => ({
		ok: true,
	})),
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	createMcpClientHubClient: (input: { userId: string }) =>
		({
			readPendingAuthorization: (readInput: { serverId: string }) =>
				mocks.readPendingAuthorization({
					ownerId: input.userId,
					serverId: readInput.serverId,
				}),
			bindOAuthAttemptActor: mocks.bindOAuthAttemptActor,
		}) as Partial<McpClientHubClient>,
}))

const { testOrgMcpServerAuthorizePostHandler, loadMcpServerAuthorizeData } =
	await import('./org-mcp-server-authorize.test-support.ts')

const cookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const origin = 'https://kody.test'
const providerUrl =
	'https://auth.acme.example/authorize?client_id=https%3A%2F%2Fkody.test%2Foauth%2Fclient-metadata.json&state=nonce-1.server-acme'

const people = {
	ada: { id: 1, email: 'ada@example.com' },
	bob: { id: 2, email: 'bob@example.com' },
	cara: { id: 3, email: 'cara@example.com' },
	dan: { id: 4, email: 'dan@example.com' },
} as const
type Person = keyof typeof people

function personId(person: Person) {
	return testStableUserIdFromEmail(people[person].email)
}

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
		['cara', 'owner'],
		['dan', 'member'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES ('org-acme', ?, ?, ?)`,
			)
			.run(personId(person), role, now)
	}
	for (const [id, ownerId, name] of [
		['server-acme', 'org-acme', 'acme-docs'],
		['server-ada', personId('ada'), 'ada-notes'],
	] as const) {
		sqlite
			.prepare(
				`INSERT INTO mcp_server_settings (id, user_id, name, url) VALUES (?, ?, ?, ?)`,
			)
			.run(id, ownerId, name, `https://mcp.${name}.example/mcp`)
	}
	mocks.readPendingAuthorization.mockReset()
	mocks.readPendingAuthorization.mockImplementation(async (input) =>
		input.ownerId === 'org-acme' && input.serverId === 'server-acme'
			? {
					serverId: 'server-acme',
					name: 'acme-docs',
					serverUrl: 'https://mcp.acme-docs.example/mcp',
					authorizationUrl: providerUrl,
					clientMode: 'cimd',
				}
			: null,
	)
	mocks.bindOAuthAttemptActor.mockReset()
	mocks.bindOAuthAttemptActor.mockResolvedValue({ ok: true })
	return {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: origin,
		COOKIE_SECRET: cookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Env
}

async function cookieFor(person: Person) {
	return createAuthCookie(
		{
			stableUserId: personId(person),
			email: people[person].email,
			rememberMe: false,
		},
		false,
	)
}

function pagePath(orgSlug: string, serverId: string) {
	return `/@${orgSlug}/-/mcp-servers/${serverId}/authorize`
}

async function openConsent(
	env: Env,
	input: {
		person: Person | null
		orgSlug?: string
		serverId?: string
		method?: 'GET' | 'HEAD'
		requestPath?: string
	},
) {
	const orgSlug = input.orgSlug ?? 'acme'
	const serverId = input.serverId ?? 'server-acme'
	const request = new Request(
		`${origin}${input.requestPath ?? pagePath(orgSlug, serverId)}`,
		{
			method: input.method ?? 'GET',
			headers: input.person ? { Cookie: await cookieFor(input.person) } : {},
		},
	)
	return loadMcpServerAuthorizeData({
		env,
		request,
		params: { orgSlug, serverId },
	})
}

async function clickContinue(
	env: Env,
	input: {
		person: Person
		csrf?: string | null
		orgSlug?: string
		serverId?: string
	},
) {
	const orgSlug = input.orgSlug ?? 'acme'
	const serverId = input.serverId ?? 'server-acme'
	const body = new URLSearchParams()
	if (input.csrf != null) body.set('_csrf', input.csrf)
	const request = new Request(`${origin}${pagePath(orgSlug, serverId)}`, {
		method: 'POST',
		headers: {
			Cookie: await cookieFor(input.person),
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
			Origin: origin,
			'Sec-Fetch-Site': 'same-origin',
		},
		body,
	})
	return testOrgMcpServerAuthorizePostHandler(env).execute({
		request,
		params: { orgSlug, serverId },
		url: new URL(request.url),
	} as never)
}

function readPage(result: Awaited<ReturnType<typeof openConsent>>) {
	if (result.kind !== 'ready')
		throw new Error(`Expected consent data, got ${result.kind}`)
	return result.payload
}

async function readContinue(response: { data: unknown }) {
	return response.data as McpServerAuthorizeContinueResponse
}

function refusedConsent(body: McpServerAuthorizeContinueResponse) {
	if (body.ok) throw new Error('Expected Continue to be refused.')
	return body
}

async function consentToken(env: Env, person: Person) {
	const page = await readPage(await openConsent(env, { person }))
	const token = page.pending?.csrfToken
	if (!token) throw new Error('Expected a pending consent form token.')
	return token
}

test('consent page shows the connection and only hands out the provider URL after Continue with its form token', async () => {
	const env = await seed()

	const anonymous = await openConsent(env, { person: null })
	expect(anonymous.kind).toBe('signed-out')
	expect(mocks.readPendingAuthorization).not.toHaveBeenCalled()

	const page = await openConsent(env, { person: 'ada' })
	expect(page.kind).toBe('ready')
	const loaded = await readPage(page)
	expect(loaded).toMatchObject({
		ok: true,
		orgSlug: 'acme',
		serverId: 'server-acme',
		serverName: 'acme-docs',
		serverUrl: 'https://mcp.acme-docs.example/mcp',
		serverHref: '/@acme/-/mcp-servers/server-acme',
		pending: {
			authorizationServerHost: 'auth.acme.example',
			clientMode: 'cimd',
			csrfToken: expect.any(String),
		},
		error: null,
	})
	expect(JSON.stringify(loaded)).not.toContain('nonce-1')
	expect(mocks.readPendingAuthorization).toHaveBeenCalledWith({
		ownerId: 'org-acme',
		serverId: 'server-acme',
	})

	const missingToken = await clickContinue(env, { person: 'ada' })
	expect(missingToken.status).toBe(403)
	expect(new Headers(missingToken.headers).get('Location')).toBeNull()
	const missingBody = refusedConsent(await readContinue(missingToken))
	expect(missingBody.error).toMatch(/expired/)
	expect(missingBody.consent?.pending?.csrfToken).toEqual(expect.any(String))
	expect(JSON.stringify(missingBody)).not.toContain('nonce-1')

	const forged = await clickContinue(env, {
		person: 'ada',
		csrf: 'not-a-real-token',
	})
	expect(forged.status).toBe(403)
	expect(JSON.stringify(await readContinue(forged))).not.toContain('nonce-1')

	const approved = await clickContinue(env, {
		person: 'ada',
		csrf: loaded.pending?.csrfToken,
	})
	expect(approved.status).toBe(200)
	expect(new Headers(approved.headers).get('Cache-Control')).toBe(
		'private, no-store',
	)
	expect(await readContinue(approved)).toEqual({
		ok: true,
		authorizationUrl: providerUrl,
	})
})

test('consent Continue refuses when the pending attempt cannot be rebound', async () => {
	const env = await seed()
	const token = await consentToken(env, 'ada')
	mocks.bindOAuthAttemptActor.mockResolvedValue({ ok: false })
	const refused = await clickContinue(env, { person: 'ada', csrf: token })
	expect(refused.status).toBe(409)
	const body = refusedConsent(await readContinue(refused))
	expect(body.error).toMatch(/Reconnect at \/account\/mcp-servers/)
	expect(body.consent?.pending?.csrfToken).toEqual(expect.any(String))
})

test('consent form tokens are bound to the person and the pending authorization', async () => {
	const env = await seed()
	const adaToken = await consentToken(env, 'ada')

	const otherOwner = await clickContinue(env, {
		person: 'cara',
		csrf: adaToken,
	})
	expect(otherOwner.status).toBe(403)
	expect(new Headers(otherOwner.headers).get('Location')).toBeNull()

	mocks.readPendingAuthorization.mockResolvedValue({
		serverId: 'server-acme',
		name: 'acme-docs',
		serverUrl: 'https://mcp.acme-docs.example/mcp',
		authorizationUrl: providerUrl.replace('nonce-1', 'nonce-2'),
		clientMode: 'dcr',
	})
	const afterReconnect = await clickContinue(env, {
		person: 'ada',
		csrf: adaToken,
	})
	expect(afterReconnect.status).toBe(403)
	const refreshed = refusedConsent(await readContinue(afterReconnect)).consent
	expect(refreshed?.pending?.clientMode).toBe('dcr')
	expect(refreshed?.pending?.csrfToken).not.toBe(adaToken)

	mocks.readPendingAuthorization.mockResolvedValue(null)
	const idle = await openConsent(env, { person: 'ada' })
	expect(idle.kind).toBe('ready')
	expect((await readPage(idle)).pending).toBeNull()
	const settled = await clickContinue(env, { person: 'ada', csrf: adaToken })
	expect(settled.status).toBe(409)
	expect(
		refusedConsent(await readContinue(settled)).consent?.pending,
	).toBeNull()
})

test('consent page refuses people outside the org, members without integration write, and other orgs’ servers', async () => {
	const env = await seed()
	const adaToken = await consentToken(env, 'ada')
	mocks.readPendingAuthorization.mockClear()

	const outsider = await openConsent(env, { person: 'bob' })
	expect(outsider.kind).toBe('not-found')
	const outsiderPost = await clickContinue(env, {
		person: 'bob',
		csrf: adaToken,
	})
	expect(outsiderPost.status).toBe(404)
	expect(await readContinue(outsiderPost)).toMatchObject({
		ok: false,
		consent: null,
	})

	const member = await openConsent(env, { person: 'dan' })
	expect(member.kind).toBe('forbidden')
	const memberPost = await clickContinue(env, { person: 'dan', csrf: adaToken })
	expect(memberPost.status).toBe(403)
	expect(await readContinue(memberPost)).toMatchObject({
		ok: false,
		consent: null,
	})

	const otherPersonalOrg = await openConsent(env, {
		person: 'bob',
		orgSlug: 'ada',
		serverId: 'server-ada',
	})
	expect(otherPersonalOrg.kind).toBe('not-found')

	const serverFromAnotherOrg = await openConsent(env, {
		person: 'ada',
		orgSlug: 'ada',
		serverId: 'server-acme',
	})
	expect(serverFromAnotherOrg.kind).toBe('not-found')
	const crossOrgPost = await clickContinue(env, {
		person: 'ada',
		orgSlug: 'ada',
		serverId: 'server-acme',
		csrf: adaToken,
	})
	expect(crossOrgPost.status).toBe(404)
	expect(await readContinue(crossOrgPost)).toMatchObject({
		ok: false,
		consent: null,
	})
	expect(mocks.readPendingAuthorization).not.toHaveBeenCalled()
})

test('consent read binds explicit org independently of the RPC URL and HEAD never continues OAuth', async () => {
	const env = await seed()
	mocks.bindOAuthAttemptActor.mockClear()
	const page = readPage(
		await openConsent(env, {
			person: 'ada',
			orgSlug: 'acme',
			serverId: 'server-acme',
			method: 'HEAD',
			requestPath: '/_serverFn/consent',
		}),
	)
	expect(page.orgSlug).toBe('acme')
	expect(page.serverId).toBe('server-acme')
	expect(mocks.readPendingAuthorization).toHaveBeenCalledWith({
		ownerId: 'org-acme',
		serverId: 'server-acme',
	})
	expect(mocks.bindOAuthAttemptActor).not.toHaveBeenCalled()
	expect(
		await openConsent(env, {
			person: 'bob',
			orgSlug: 'acme',
			requestPath: '/_serverFn/consent',
		}),
	).toMatchObject({ kind: 'not-found' })
})
