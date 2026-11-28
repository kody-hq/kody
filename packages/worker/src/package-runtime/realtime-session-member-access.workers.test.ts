import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { beforeEach, expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type { RuntimePackageAppVisitSession } from '@kody-internal/shared/runtime-worker.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { readPackageAppSession } from '#app/package-app-session.ts'
import { revokeApiToken } from '#worker/api-tokens/service.ts'
import {
	accessFixture,
	packageAppSessionCookieFor,
	seedPackageAppAccessFixture,
	type AccessFixturePerson,
} from '#worker/test-support/package-app-access-fixture.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	packageRealtimeSessionRpc,
	realtimeAccessRecheckMs,
	type PackageRealtimeConnectOptions,
	type PackageRealtimeSession,
} from './realtime-session.ts'

/**
 * Member sockets are re-authorized with the same decision the next HTTP
 * request from their visit session gets, against real D1 access rows. Only
 * the app hook is stubbed: the fixture apps have no published source.
 */

const mutableEnv = env as unknown as Record<string, unknown>
const { orgId, orgSlug, privateApp } = accessFixture
const privateOrigin = `https://${privateApp.slug}--${orgSlug}.packages.isolated.test`

type TestInstance = {
	resolveRealtimeHookResult: () => Promise<Array<unknown>>
	recordSessionUsage: () => void
	alarm: () => Promise<void>
	stateSnapshot: {
		sessions: Record<
			string,
			{ facet: string; visitSession?: RuntimePackageAppVisitSession | null }
		>
	}
}

beforeEach(async () => {
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
	setAuthSessionSecret(env.COOKIE_SECRET)
	await seedPackageAppAccessFixture()
	// Decisions are cached per access epoch; a test may have removed a grant.
	await bumpAccessEpoch()
	for (const person of Object.values(accessFixture.people)) {
		invalidatePackageAppOwnerCache({
			stableUserId: testStableUserIdFromEmail(person.email),
		})
	}
})

function bumpAccessEpoch() {
	return env.APP_DB.prepare(
		`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`,
	)
		.bind(orgId)
		.run()
}

function createBinding(): {
	env: Env
	userId: ReturnType<typeof ownerIdFromStored>
	packageId: string
	kodyId: string
	sourceId: string
	baseUrl: string
} {
	return {
		env,
		userId: ownerIdFromStored(orgId),
		packageId: privateApp.id,
		kodyId: privateApp.slug,
		sourceId: `src-${privateApp.id}`,
		baseUrl: 'https://app.kody.test:8788',
	}
}

function getStub(binding: ReturnType<typeof createBinding>) {
	const namespace =
		env.PACKAGE_REALTIME_SESSION as DurableObjectNamespace<PackageRealtimeSession>
	return namespace.get(
		namespace.idFromName(JSON.stringify([binding.userId, binding.packageId])),
	)
}

function inInstance(
	binding: ReturnType<typeof createBinding>,
	run: (instance: TestInstance, state: DurableObjectState) => Promise<void>,
) {
	return runInDurableObject(getStub(binding), async (instance, state) => {
		await run(instance as unknown as TestInstance, state)
	})
}

async function prepare(binding: ReturnType<typeof createBinding>) {
	await inInstance(binding, async (instance) => {
		instance.resolveRealtimeHookResult = async () => []
		instance.recordSessionUsage = () => undefined
	})
}

function visitSessionFor(
	person: AccessFixturePerson,
	overrides: Partial<RuntimePackageAppVisitSession> = {},
): RuntimePackageAppVisitSession {
	return {
		stableUserId: testStableUserIdFromEmail(accessFixture.people[person].email),
		issuedAt: Date.now() - 1_000,
		expiresAt: Date.now() + 60 * 60 * 1000,
		handle: orgSlug,
		kodyId: privateApp.slug,
		...overrides,
	}
}

async function connect(
	binding: ReturnType<typeof createBinding>,
	facet: string,
	visitSession: RuntimePackageAppVisitSession | null,
) {
	const options: PackageRealtimeConnectOptions = {
		access: 'member',
		visitor: null,
		visitSession,
	}
	const response = await packageRealtimeSessionRpc(binding).connect(
		new Request(`${privateOrigin}/ws/${facet}`, {
			headers: { Upgrade: 'websocket' },
		}),
		facet,
		options,
	)
	const socket = response.webSocket
	socket?.accept()
	let close: { code: number; reason: string } | null = null
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		socket?.addEventListener('close', (event) => {
			close = { code: event.code, reason: event.reason }
			resolve(close)
		})
	})
	return { response, socket, closed, isOpen: () => close === null }
}

async function openFacets(binding: ReturnType<typeof createBinding>) {
	const { sessions } = await packageRealtimeSessionRpc(binding).listSessions()
	return sessions.map((session) => session.facet).sort()
}

test('a member connect without the visit session it was opened from is refused', async () => {
	const binding = createBinding()
	await prepare(binding)
	const refused = await connect(binding, 'room', null)
	expect(refused.response.status).toBe(403)
})

test('removing a grant closes that member socket at the next recheck while the owner stays connected', async () => {
	const binding = createBinding()
	await prepare(binding)
	const member = await connect(binding, 'member', visitSessionFor('member'))
	const owner = await connect(binding, 'owner', visitSessionFor('owner'))
	expect(member.response.status).toBe(101)
	await inInstance(binding, async (instance, state) => {
		const alarm = await state.storage.getAlarm()
		expect(alarm).not.toBeNull()
		expect(alarm ?? Infinity).toBeLessThanOrEqual(
			Date.now() + realtimeAccessRecheckMs,
		)
		await instance.alarm()
	})
	expect(await openFacets(binding)).toEqual(['member', 'owner'])

	await env.APP_DB.prepare(
		`DELETE FROM grants WHERE id = 'grant-cost-member'`,
	).run()
	await bumpAccessEpoch()
	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	await expect(member.closed).resolves.toEqual({
		code: 1008,
		reason: 'access-revoked',
	})
	expect(owner.isOpen()).toBe(true)
	expect(await openFacets(binding)).toEqual(['owner'])
	owner.socket?.close(1000, 'done')
})

test('revoking the API token closes the socket an agent visit opened', async () => {
	const binding = createBinding()
	await prepare(binding)
	const userId = testStableUserIdFromEmail(accessFixture.people.owner.email)
	const tokenId = `realtime-agent-token-${crypto.randomUUID()}`
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS api_tokens (
			id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, org_id TEXT NOT NULL,
			org_binding TEXT NOT NULL DEFAULT 'org', name TEXT NOT NULL,
			token_hash TEXT NOT NULL, scopes_json TEXT NOT NULL,
			idle_ttl_seconds INTEGER NOT NULL, expires_at TEXT NOT NULL,
			max_expires_at TEXT NOT NULL, created_via TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
			rotated_at TEXT, revoked_at TEXT, profile_id TEXT, deleted_at TEXT
		)`,
	).run()
	const nowIso = new Date().toISOString()
	const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
	await env.APP_DB.prepare(
		`INSERT INTO api_tokens (
			id, user_id, org_id, name, token_hash, scopes_json, idle_ttl_seconds,
			expires_at, max_expires_at, created_via, created_at, updated_at
		) VALUES (?, ?, ?, 'realtime-agent', 'hash', '["app:execute"]', 3600, ?, ?, 'api', ?, ?)`,
	)
		.bind(tokenId, userId, userId, expiresAt, expiresAt, nowIso, nowIso)
		.run()
	const agent = await connect(
		binding,
		'agent',
		visitSessionFor('owner', {
			credential: { kind: 'api-token', id: tokenId, scopes: ['app:execute'] },
		}),
	)
	const person = await connect(binding, 'person', visitSessionFor('owner'))
	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	expect(await openFacets(binding)).toEqual(['agent', 'person'])

	await revokeApiToken({ db: env.APP_DB, userId, tokenId })
	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	await expect(agent.closed).resolves.toEqual({
		code: 1008,
		reason: 'access-revoked',
	})
	expect(person.isOpen()).toBe(true)
	person.socket?.close(1000, 'done')
})

test('a visit session closes when its cookie expires, on the alarm and before any frame is delivered', async () => {
	const binding = createBinding()
	await prepare(binding)
	const expiresAt = Date.now() + 30_000
	const framed = await connect(
		binding,
		'framed',
		visitSessionFor('owner', { expiresAt }),
	)
	const alarmed = await connect(
		binding,
		'alarmed',
		visitSessionFor('owner', { expiresAt }),
	)
	const live = await connect(binding, 'live', visitSessionFor('owner'))
	const sessionIds: Record<string, string> = {}
	await inInstance(binding, async (instance, state) => {
		// The alarm fires no later than the hard expiry.
		expect(await state.storage.getAlarm()).toBeLessThanOrEqual(expiresAt)
		for (const [id, session] of Object.entries(
			instance.stateSnapshot.sessions,
		)) {
			sessionIds[session.facet] = id
			if (session.facet !== 'live' && session.visitSession) {
				session.visitSession.expiresAt = Date.now() - 1
			}
		}
	})

	const rpc = packageRealtimeSessionRpc(binding)
	await expect(rpc.emit(sessionIds.framed ?? '', 'hello')).resolves.toEqual({
		delivered: false,
		reason: 'session_not_connected',
	})
	await expect(framed.closed).resolves.toEqual({
		code: 1008,
		reason: 'session-expired',
	})

	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	await expect(alarmed.closed).resolves.toEqual({
		code: 1008,
		reason: 'session-expired',
	})
	expect(live.isOpen()).toBe(true)
	live.socket?.close(1000, 'done')
})

test('signing out of the app closes the sockets that visit session opened, and only those', async () => {
	const binding = createBinding()
	await prepare(binding)
	const cookie = await packageAppSessionCookieFor('member')
	const parsed = await readPackageAppSession({
		request: new Request(`${privateOrigin}/`, { headers: { Cookie: cookie } }),
		env,
		slug: privateApp.slug,
	})
	if (!parsed) throw new Error('Expected a parsed package-app session.')
	const otherApp = { ...binding, packageId: `package-${crypto.randomUUID()}` }
	await prepare(otherApp)
	const signedIn = await connect(
		otherApp,
		'signed-in',
		visitSessionFor('member', {
			issuedAt: parsed.issuedAt,
			expiresAt: parsed.expiresAt,
		}),
	)
	const onApp = await connect(
		binding,
		'on-app',
		visitSessionFor('member', {
			issuedAt: parsed.issuedAt,
			expiresAt: parsed.expiresAt,
		}),
	)
	const otherOnApp = await connect(
		binding,
		'other-on-app',
		visitSessionFor('member'),
	)

	const response = await exports.default.fetch(
		new Request(`${privateOrigin}/-/auth/logout`, {
			redirect: 'manual',
			headers: { Cookie: cookie },
		}),
	)
	expect(response.status).toBe(302)
	await expect(onApp.closed).resolves.toEqual({
		code: 1008,
		reason: 'signed-out',
	})
	expect(otherOnApp.isOpen()).toBe(true)
	// Another app's sockets are untouched.
	expect(signedIn.isOpen()).toBe(true)
	for (const socket of [signedIn, otherOnApp]) {
		socket.socket?.close(1000, 'done')
	}
})

test("withdrawing an outside collaborator's Run as me approval closes their socket", async () => {
	const binding = createBinding()
	await prepare(binding)
	const collaboratorId = testStableUserIdFromEmail(
		accessFixture.people.collaborator.email,
	)
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO package_app_run_consents (person_id, package_id, approved_at)
		 VALUES (?, ?, ?)`,
	)
		.bind(collaboratorId, privateApp.id, new Date().toISOString())
		.run()
	const collaborator = await connect(
		binding,
		'collaborator',
		visitSessionFor('collaborator'),
	)
	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	expect(collaborator.isOpen()).toBe(true)

	await env.APP_DB.prepare(
		`DELETE FROM package_app_run_consents WHERE person_id = ? AND package_id = ?`,
	)
		.bind(collaboratorId, privateApp.id)
		.run()
	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	await expect(collaborator.closed).resolves.toEqual({
		code: 1008,
		reason: 'access-revoked',
	})
})

test('a socket closes once its session slug names a different app than the one it runs', async () => {
	const binding = {
		...createBinding(),
		packageId: `package-${crypto.randomUUID()}`,
	}
	await prepare(binding)
	const owner = await connect(binding, 'owner', visitSessionFor('owner'))
	await inInstance(binding, async (instance) => {
		await instance.alarm()
	})
	await expect(owner.closed).resolves.toEqual({
		code: 1008,
		reason: 'access-revoked',
	})
})
