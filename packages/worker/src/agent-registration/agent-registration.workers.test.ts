import {
	applyD1Migrations,
	createExecutionContext,
	type D1Migration,
	waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, test, vi } from 'vitest'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { originWorkerHandler } from '../origin-handler.ts'
import { agentClaimGrantType } from './grant-type.ts'
import { decideAgentClaimForPerson, lookupAgentClaim } from './verification.ts'

vi.mock('../../start/server.ts', () => ({
	renderNativeDocument: async () => new Response('not used', { status: 500 }),
}))

const origin = 'https://heykody.dev'

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
})

async function workerFetch(request: Request) {
	const handleFetch = originWorkerHandler.fetch
	if (!handleFetch) throw new Error('Expected the origin fetch handler.')
	const ctx = createExecutionContext()
	const response = await handleFetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

function randomIp() {
	return `198.51.100.${Math.floor(Math.random() * 250)}`
}

function postJson(path: string, body: unknown, ip = randomIp()) {
	return workerFetch(
		new Request(`${origin}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
			body: JSON.stringify(body),
		}),
	)
}

type Registration = {
	registration_id: string
	registration_type: string
	claim_token: string
	claim_token_expires: string
	post_claim_scopes: Array<string>
	claim: {
		user_code: string
		verification_uri: string
		expires_in: number
		interval: number
	}
}

async function register(email: string) {
	const response = await postJson('/agent/identity', {
		type: 'service_auth',
		login_hint: email,
	})
	expect(response.status).toBe(200)
	return (await response.json()) as Registration
}

function attemptTokenFrom(registration: Pick<Registration, 'claim'>) {
	return new URL(registration.claim.verification_uri).searchParams.get(
		'claim_attempt_token',
	)
}

async function poll(claimToken: string) {
	const response = await workerFetch(
		new Request(`${origin}/oauth/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: agentClaimGrantType,
				claim_token: claimToken,
			}),
		}),
	)
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	}
}

async function allowNextPoll() {
	await env.APP_DB.prepare(
		'UPDATE agent_registrations SET last_polled_at = NULL',
	).run()
}

async function seedPerson(emailVerifiedAt?: string | null) {
	const email = `agent-${crypto.randomUUID().slice(0, 8)}@example.com`
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `agt${crypto.randomUUID().slice(0, 8)}`,
		...(emailVerifiedAt === undefined ? {} : { emailVerifiedAt }),
	})
	return { personId: testStableUserIdFromEmail(email), email }
}

function claimRequest(ip = '192.0.2.10') {
	return new Request(`${origin}/agent/claim`, {
		headers: { 'CF-Connecting-IP': ip },
	})
}

test('discovery advertises agent_auth with service_auth and the claim grant', async () => {
	const response = await workerFetch(
		new Request(`${origin}/.well-known/oauth-authorization-server`),
	)
	expect(response.status).toBe(200)
	const metadata = (await response.json()) as Record<string, unknown>
	expect(metadata.agent_auth).toEqual({
		skill: `${origin}/auth.md`,
		identity_endpoint: `${origin}/agent/identity`,
		claim_endpoint: `${origin}/agent/identity/claim`,
		identity_types_supported: ['service_auth'],
	})
	expect(metadata.grant_types_supported).toEqual(
		expect.arrayContaining([agentClaimGrantType]),
	)
})

test('anonymous, identity_assertion, and bad login hints are refused', async () => {
	const anonymous = await postJson('/agent/identity', { type: 'anonymous' })
	expect(anonymous.status).toBe(400)
	expect(await anonymous.json()).toMatchObject({
		error: 'anonymous_not_enabled',
	})
	const assertion = await postJson('/agent/identity', {
		type: 'identity_assertion',
		assertion: 'x',
	})
	expect(await assertion.json()).toMatchObject({ error: 'issuer_not_enabled' })
	const badHint = await postJson('/agent/identity', {
		type: 'service_auth',
		login_hint: 'Person <person@example.com>',
	})
	expect(await badHint.json()).toMatchObject({ error: 'invalid_login_hint' })
})

test('registration returns spec fields; the claim mints one kody_at_ token', async () => {
	const person = await seedPerson()
	const registration = await register(person.email.toUpperCase())
	expect(registration).toMatchObject({
		registration_type: 'service_auth',
		claim: { expires_in: 600, interval: 5 },
	})
	expect(registration.claim.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
	expect(registration.claim.verification_uri).toMatch(
		new RegExp(`^${origin}/agent/claim\\?claim_attempt_token=kody_cla_`),
	)
	expect(registration.post_claim_scopes).toContain('org:execute')

	expect((await poll(registration.claim_token)).body.error).toBe(
		'authorization_pending',
	)
	expect((await poll(registration.claim_token)).body).toMatchObject({
		error: 'slow_down',
		interval: 10,
	})

	const attemptToken = attemptTokenFrom(registration)
	await expect(
		lookupAgentClaim({ env, user: person, attemptToken }),
	).resolves.toMatchObject({
		kind: 'found',
		request: { claimEmail: person.email },
	})
	await expect(
		decideAgentClaimForPerson({
			request: claimRequest(),
			env,
			user: person,
			attemptToken,
			userCode: 'BBBB-BBBB',
			decision: 'approve',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'invalid_code' })
	await expect(
		decideAgentClaimForPerson({
			request: claimRequest(),
			env,
			user: person,
			attemptToken,
			userCode: registration.claim.user_code.toLowerCase(),
			decision: 'approve',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'approved' })

	await allowNextPoll()
	const granted = await poll(registration.claim_token)
	expect(granted.status).toBe(200)
	expect(granted.body).toMatchObject({ token_type: 'Bearer' })
	expect(String(granted.body.access_token)).toMatch(/^kody_at_/)
	expect(granted.body).not.toHaveProperty('refresh_token')
	expect(Number(granted.body.expires_in)).toBeGreaterThan(60 * 60 * 24)
	const token = await env.APP_DB.prepare(
		`SELECT created_via, user_id, org_binding FROM api_tokens
		WHERE name = 'kody-agent' ORDER BY created_at DESC LIMIT 1`,
	).first<{ created_via: string; user_id: string; org_binding: string }>()
	expect(token).toEqual({
		created_via: 'agent-registration',
		user_id: person.personId,
		org_binding: 'org',
	})

	await allowNextPoll()
	expect((await poll(registration.claim_token)).body.error).toBe(
		'invalid_grant',
	)
}, 60_000)

test('a different signed-in email cannot claim', async () => {
	const owner = await seedPerson()
	const other = await seedPerson()
	const registration = await register(owner.email)
	const attemptToken = attemptTokenFrom(registration)
	await expect(
		lookupAgentClaim({ env, user: other, attemptToken }),
	).resolves.toEqual({ kind: 'email_mismatch', claimEmail: owner.email })
	await expect(
		decideAgentClaimForPerson({
			request: claimRequest(),
			env,
			user: other,
			attemptToken,
			userCode: registration.claim.user_code,
			decision: 'approve',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'email_mismatch', claimEmail: owner.email })
})

test('an unverified email cannot claim', async () => {
	const person = await seedPerson(null)
	const registration = await register(person.email)
	await expect(
		decideAgentClaimForPerson({
			request: claimRequest(),
			env,
			user: person,
			attemptToken: attemptTokenFrom(registration),
			userCode: registration.claim.user_code,
			decision: 'approve',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'email_unverified' })
})

test('deny, fresh attempts, and expiry', async () => {
	const person = await seedPerson()
	const denied = await register(person.email)
	await expect(
		decideAgentClaimForPerson({
			request: claimRequest(),
			env,
			user: person,
			attemptToken: attemptTokenFrom(denied),
			userCode: null,
			decision: 'deny',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'denied' })
	expect((await poll(denied.claim_token)).body.error).toBe('access_denied')

	const restarted = await register(person.email)
	const wrongEmail = await postJson('/agent/identity/claim', {
		claim_token: restarted.claim_token,
		email: 'someone-else@example.com',
	})
	expect(wrongEmail.status).toBe(400)
	const fresh = await postJson('/agent/identity/claim', {
		claim_token: restarted.claim_token,
		email: person.email,
	})
	expect(fresh.status).toBe(200)
	const freshBody = (await fresh.json()) as {
		status: string
		claim_attempt: Registration['claim']
	}
	expect(freshBody.status).toBe('initiated')
	await expect(
		lookupAgentClaim({
			env,
			user: person,
			attemptToken: attemptTokenFrom(restarted),
		}),
	).resolves.toEqual({ kind: 'not_found' })
	await expect(
		lookupAgentClaim({
			env,
			user: person,
			attemptToken: attemptTokenFrom({ claim: freshBody.claim_attempt }),
		}),
	).resolves.toMatchObject({ kind: 'found' })

	await env.APP_DB.prepare(
		'UPDATE agent_registrations SET expires_at = ? WHERE id = ?',
	)
		.bind(Math.floor(Date.now() / 1000) - 1, restarted.registration_id)
		.run()
	expect((await poll(restarted.claim_token)).body.error).toBe('expired_token')
	const late = await postJson('/agent/identity/claim', {
		claim_token: restarted.claim_token,
		email: person.email,
	})
	expect(late.status).toBe(410)
	expect(await late.json()).toMatchObject({ error: 'claim_expired' })
})
