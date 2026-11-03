import { expect, test } from 'vitest'
import worker from './worker.ts'

const origin = 'https://kody-pr-1-mock-oauth.example.workers.dev'

function post(path: string, form: Record<string, string>) {
	return worker.fetch(
		new Request(`${origin}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(form),
		}),
	)
}

test('device flow issues a code then approves it with a usable access token', async () => {
	const device = await post('/device/code', { client_id: 'mock-client' })
	expect(device.status).toBe(200)
	const code = (await device.json()) as Record<string, unknown>
	expect(code).toMatchObject({
		user_code: 'MOCK-0000',
		verification_uri: `${origin}/device`,
		expires_in: 600,
	})

	const token = await post('/token', {
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		device_code: String(code.device_code),
		client_id: 'mock-client',
	})
	expect(token.status).toBe(200)
	const tokens = (await token.json()) as Record<string, string>
	expect(tokens.access_token).toMatch(/^mock-access-/)

	const me = await worker.fetch(
		new Request(`${origin}/userinfo`, {
			headers: { Authorization: `Bearer ${tokens.access_token}` },
		}),
	)
	expect(await me.json()).toMatchObject({ email: 'mock-user@example.com' })

	const refreshed = await post('/token', {
		grant_type: 'refresh_token',
		refresh_token: String(tokens.refresh_token),
		client_id: 'mock-client',
	})
	expect(refreshed.status).toBe(200)
})

test('mock provider refuses deny clients, bad grants, and bad tokens', async () => {
	const denied = await post('/token', {
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		device_code: 'mock-device-1',
		client_id: 'mock-deny',
	})
	expect(await denied.json()).toEqual({ error: 'access_denied' })
	expect((await post('/device/code', {})).status).toBe(401)
	const unsupported = await post('/token', {
		grant_type: 'password',
		client_id: 'mock-client',
	})
	expect(await unsupported.json()).toEqual({ error: 'unsupported_grant_type' })
	const me = await worker.fetch(
		new Request(`${origin}/userinfo`, {
			headers: { Authorization: 'Bearer x' },
		}),
	)
	expect(me.status).toBe(401)
})

test('authorize redirects back with a code and the caller state', async () => {
	const response = await worker.fetch(
		new Request(
			`${origin}/authorize?client_id=mock-client&redirect_uri=${encodeURIComponent('https://app.example/callback')}&state=abc`,
		),
	)
	expect(response.status).toBe(302)
	const location = new URL(response.headers.get('location') ?? '')
	expect(location.origin + location.pathname).toBe(
		'https://app.example/callback',
	)
	expect(location.searchParams.get('state')).toBe('abc')
	expect(location.searchParams.get('code')).toMatch(/^mock-code-/)
})
