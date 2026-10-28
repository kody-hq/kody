import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loginWithDevice } from '../src/auth.js'
import {
	detectHeadlessLoginReason,
	formatDeviceLoginNotice,
} from '../src/login-notice.js'
import { createFileBackend } from '../src/store.js'

const origin = 'https://device.test'
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'

function deviceServer(tokenReplies: Array<Record<string, unknown>>) {
	const seen: Array<{ path: string; body: URLSearchParams | null }> = []
	const fetchFn: typeof fetch = async (input, init) => {
		const request = new Request(input, init)
		const url = new URL(request.url)
		const body =
			request.method === 'POST' && url.origin === origin
				? new URLSearchParams(await request.text())
				: null
		seen.push({ path: url.pathname, body })
		if (url.pathname.includes('oauth-authorization-server')) {
			return Response.json({
				issuer: origin,
				authorization_endpoint: `${origin}/oauth/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				device_authorization_endpoint: `${origin}/oauth/device_authorization`,
				grant_types_supported: [
					'authorization_code',
					'refresh_token',
					deviceGrant,
				],
			})
		}
		if (url.pathname === '/oauth/device_authorization') {
			return Response.json({
				device_code: 'kody_dc_test',
				user_code: 'BCDF-GHJK',
				verification_uri: `${origin}/device`,
				verification_uri_complete: `${origin}/device?user_code=BCDF-GHJK`,
				expires_in: 600,
				interval: 5,
			})
		}
		if (url.pathname === '/oauth/token') {
			const reply = tokenReplies.shift() ?? { error: 'expired_token' }
			return Response.json(reply, { status: 'error' in reply ? 400 : 200 })
		}
		if (url.pathname === '/v1/tokens/device') {
			assert.equal(request.headers.get('Authorization'), 'Bearer oauth-access')
			return Response.json({
				token: 'kody_at_device',
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				scopes: ['org:read'],
				login_org: { slug: 'acme' },
			})
		}
		return new Response('not found', { status: 404 })
	}
	return { fetchFn, seen }
}

function backend() {
	const dir = mkdtempSync(join(tmpdir(), 'kody-device-'))
	return createFileBackend(join(dir, 'credentials.json'))
}

test('device login polls through pending and slow_down, then stores the device token', async () => {
	const { fetchFn, seen } = deviceServer([
		{ error: 'authorization_pending' },
		{ error: 'slow_down' },
		{ access_token: 'oauth-access', token_type: 'bearer', expires_in: 3600 },
	])
	const waits: Array<number> = []
	const prompts: Array<string> = []
	const result = await loginWithDevice({
		mcpUrl: `${origin}/mcp`,
		apiUrl: 'https://api.device.test',
		org: 'Acme',
		fetchFn,
		backend: backend(),
		sleep: async (ms) => {
			waits.push(ms)
		},
		discoverIdentity: async () => ({
			org: 'acme',
			account: { email: 'person@example.com' },
		}),
		onDeviceCode: (prompt) => prompts.push(formatDeviceLoginNotice(prompt)),
	})
	assert.deepEqual(waits, [5000, 5000, 10000])
	assert.equal(result.credentials.accessToken, 'kody_at_device')
	assert.equal(result.org, 'acme')
	assert.match(prompts[0] ?? '', /BCDF-GHJK/)
	assert.match(prompts[0] ?? '', /device\?user_code=BCDF-GHJK/)
	const start = seen.find(
		(entry) => entry.path === '/oauth/device_authorization',
	)
	assert.equal(
		start?.body?.get('client_id'),
		`${origin}/oauth/cli-client-metadata.json`,
	)
	assert.equal(start?.body?.get('org'), 'acme')
	const tokenPoll = seen.find((entry) => entry.path === '/oauth/token')
	assert.equal(tokenPoll?.body?.get('grant_type'), deviceGrant)
	assert.equal(tokenPoll?.body?.get('device_code'), 'kody_dc_test')
})

test('device login stops on denial and on expiry with a readable message', async () => {
	for (const [error, pattern] of [
		['access_denied', /denied in the browser/],
		['expired_token', /expired before it was approved/],
	] as const) {
		const { fetchFn } = deviceServer([{ error }])
		await assert.rejects(
			() =>
				loginWithDevice({
					mcpUrl: `${origin}/mcp`,
					fetchFn,
					backend: backend(),
					sleep: async () => {},
				}),
			pattern,
		)
	}
})

test('headless detection suggests --device over SSH or with no display', () => {
	assert.equal(
		detectHeadlessLoginReason({ SSH_CONNECTION: '1 2 3 4' }, 'darwin'),
		'ssh',
	)
	assert.equal(detectHeadlessLoginReason({}, 'linux'), 'no_display')
	assert.equal(detectHeadlessLoginReason({ DISPLAY: ':0' }, 'linux'), null)
	assert.equal(detectHeadlessLoginReason({}, 'darwin'), null)
})
