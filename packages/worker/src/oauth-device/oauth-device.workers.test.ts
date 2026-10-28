import {
	applyD1Migrations,
	createExecutionContext,
	type D1Migration,
	waitOnExecutionContext,
} from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { buildCliClientIdMetadataDocument } from '#worker/cli-client-metadata.ts'
import { seedAccount } from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { originWorkerHandler } from '../origin-handler.ts'
import { deviceCodeGrantType } from './device-grant.ts'
import {
	decideDeviceAuthorizationForPerson,
	deviceUserCodeRateLimit,
	lookupDeviceAuthorization,
} from './verification.ts'

vi.mock('../../start/server.ts', () => ({
	renderNativeDocument: async () => new Response('not used', { status: 500 }),
}))

const origin = 'https://heykody.dev'
const cliClientId = `${origin}/oauth/cli-client-metadata.json`
const resource = `${origin}/mcp`

const testEnv = env as Env & {
	TEST_MIGRATIONS: Array<D1Migration>
	TEST_AUDIT_MIGRATIONS: Array<D1Migration>
}

beforeAll(async () => {
	await applyD1Migrations(testEnv.APP_DB, testEnv.TEST_MIGRATIONS)
	await applyD1Migrations(testEnv.AUDIT_DB, testEnv.TEST_AUDIT_MIGRATIONS)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

/** The provider resolves the CLI CIMD document over fetch; serve it locally. */
function serveCliMetadata() {
	const realFetch = globalThis.fetch
	vi.stubGlobal(
		'fetch',
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input))
			if (url.href === cliClientId) {
				return Response.json(buildCliClientIdMetadataDocument(origin))
			}
			return realFetch(input, init)
		},
	)
}

async function workerFetch(request: Request) {
	const handleFetch = originWorkerHandler.fetch
	if (!handleFetch) throw new Error('Expected the origin fetch handler.')
	const ctx = createExecutionContext()
	const response = await handleFetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

function postForm(
	path: string,
	data: Record<string, string>,
	ip = '203.0.113.9',
) {
	return workerFetch(
		new Request(`${origin}${path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'CF-Connecting-IP': ip,
			},
			body: new URLSearchParams(data),
		}),
	)
}

type DeviceStart = {
	device_code: string
	user_code: string
	verification_uri: string
	verification_uri_complete: string
	expires_in: number
	interval: number
}

async function startDevice(
	ip = `198.51.100.${Math.floor(Math.random() * 250)}`,
) {
	const response = await postForm(
		'/oauth/device_authorization',
		{ client_id: cliClientId, scope: 'profile email', resource },
		ip,
	)
	expect(response.status).toBe(200)
	return (await response.json()) as DeviceStart
}

/** Clears the poll clock so the next poll is on time. */
async function allowNextPoll() {
	await env.APP_DB.prepare(
		'UPDATE oauth_device_authorizations SET last_polled_at = NULL',
	).run()
}

async function poll(deviceCode: string, clientId = cliClientId) {
	const response = await postForm('/oauth/token', {
		grant_type: deviceCodeGrantType,
		device_code: deviceCode,
		client_id: clientId,
		resource,
	})
	return {
		status: response.status,
		body: (await response.json()) as Record<string, unknown>,
	}
}

async function seedPerson() {
	const email = `device-${crypto.randomUUID().slice(0, 8)}@example.com`
	await seedAccount({
		db: env.APP_DB,
		email,
		username: `dev${crypto.randomUUID().slice(0, 8)}`,
	})
	return { personId: testStableUserIdFromEmail(email), email }
}

function verificationRequest(ip = '192.0.2.10') {
	return new Request(`${origin}/device`, {
		headers: { 'CF-Connecting-IP': ip },
	})
}

test('discovery advertises the device endpoint and grant type', async () => {
	const response = await workerFetch(
		new Request(`${origin}/.well-known/oauth-authorization-server`),
	)
	const metadata = (await response.json()) as Record<string, unknown>
	expect(metadata.device_authorization_endpoint).toBe(
		`${origin}/oauth/device_authorization`,
	)
	expect(metadata.grant_types_supported).toContain(deviceCodeGrantType)
	expect(metadata.token_endpoint).toBe(`${origin}/oauth/token`)
})

test('device authorization returns RFC 8628 fields with a readable user code', async () => {
	const started = await startDevice()
	expect(started.user_code).toMatch(
		/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
	)
	expect(started.verification_uri).toBe(`${origin}/device`)
	expect(
		new URL(started.verification_uri_complete).searchParams.get('user_code'),
	).toBe(started.user_code)
	expect(started.expires_in).toBe(600)
	expect(started.interval).toBeGreaterThanOrEqual(5)
	const row = await env.APP_DB.prepare(
		'SELECT device_code_hash FROM oauth_device_authorizations WHERE device_code_hash = ?',
	)
		.bind(started.device_code)
		.first()
	expect(row).toBeNull()
})

test('other clients are refused at both endpoints', async () => {
	const start = await postForm('/oauth/device_authorization', {
		client_id: 'https://evil.example/client.json',
	})
	expect(start.status).toBe(400)
	expect(await start.json()).toMatchObject({ error: 'unauthorized_client' })

	const started = await startDevice()
	const wrong = await poll(
		started.device_code,
		'https://evil.example/client.json',
	)
	expect(wrong.body.error).toBe('unauthorized_client')
})

test('pending, slow_down, deny, and expiry', async () => {
	const person = await seedPerson()
	const pending = await startDevice()
	expect((await poll(pending.device_code)).body.error).toBe(
		'authorization_pending',
	)
	const tooFast = await poll(pending.device_code)
	expect(tooFast.body).toMatchObject({ error: 'slow_down', interval: 10 })

	const denied = await startDevice()
	await expect(
		decideDeviceAuthorizationForPerson({
			request: verificationRequest(),
			env,
			user: person,
			userCode: denied.user_code,
			decision: 'deny',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'denied' })
	await allowNextPoll()
	expect((await poll(denied.device_code)).body.error).toBe('access_denied')

	const expired = await startDevice()
	await env.APP_DB.prepare(
		'UPDATE oauth_device_authorizations SET expires_at = ? WHERE user_code = ?',
	)
		.bind(Math.floor(Date.now() / 1000) - 1, expired.user_code.replace('-', ''))
		.run()
	expect((await poll(expired.device_code)).body.error).toBe('expired_token')
	await expect(
		lookupDeviceAuthorization({
			request: verificationRequest(),
			env,
			user: person,
			userCode: expired.user_code,
		}),
	).resolves.toEqual({ kind: 'not_found' })
})

test('approved device gets provider tokens once; a reused device_code is refused', async () => {
	serveCliMetadata()
	const person = await seedPerson()
	const started = await startDevice()
	const lookup = await lookupDeviceAuthorization({
		request: verificationRequest(),
		env,
		user: person,
		userCode: started.user_code.toLowerCase(),
	})
	expect(lookup).toMatchObject({
		kind: 'found',
		request: {
			userCode: started.user_code,
			clientName: '@kodycodes/cli',
			scopes: ['profile', 'email'],
		},
	})
	await expect(
		decideDeviceAuthorizationForPerson({
			request: verificationRequest(),
			env,
			user: person,
			userCode: started.user_code,
			decision: 'approve',
			orgSlug: null,
		}),
	).resolves.toEqual({ kind: 'approved' })

	const granted = await poll(started.device_code)
	expect(granted.status).toBe(200)
	expect(granted.body).toMatchObject({ token_type: 'bearer' })
	expect(typeof granted.body.access_token).toBe('string')
	expect(typeof granted.body.refresh_token).toBe('string')

	await allowNextPoll()
	const reused = await poll(started.device_code)
	expect(reused.status).toBe(400)
	expect(reused.body.error).toBe('invalid_grant')
}, 60_000)

test('user code guesses are rate limited per person, and misses keep their slot', async () => {
	const person = await seedPerson()
	const started = await startDevice()
	for (
		let attempt = 0;
		attempt < deviceUserCodeRateLimit.maxRequests;
		attempt += 1
	) {
		await expect(
			lookupDeviceAuthorization({
				request: verificationRequest(`192.0.2.${100 + attempt}`),
				env,
				user: person,
				userCode: 'BBBB-BBBB',
			}),
		).resolves.toEqual({ kind: 'not_found' })
	}
	await expect(
		lookupDeviceAuthorization({
			request: verificationRequest('192.0.2.200'),
			env,
			user: person,
			userCode: started.user_code,
		}),
	).resolves.toMatchObject({ kind: 'rate_limited' })
})

test('a sign-in started for an org the person cannot use offers no org to approve', async () => {
	const person = await seedPerson()
	const response = await postForm('/oauth/device_authorization', {
		client_id: cliClientId,
		scope: 'profile email',
		resource,
		org: 'not-my-organization',
	})
	const started = (await response.json()) as DeviceStart
	await expect(
		lookupDeviceAuthorization({
			request: verificationRequest('192.0.2.77'),
			env,
			user: person,
			userCode: started.user_code,
		}),
	).resolves.toMatchObject({
		kind: 'found',
		request: {
			requestedOrgSlug: 'not-my-organization',
			requestedOrgUnavailable: true,
			orgs: [],
			selectedOrgSlug: null,
		},
	})
})
