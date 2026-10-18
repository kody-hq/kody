import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { expect, test } from 'vitest'
import {
	DEVICE_CODE_GRANT_TYPE,
	rehearsalEchoPath,
	rehearsalOauthDeviceAuthorizePath,
	rehearsalOauthTokenPath,
	rehearsalSecretHeader,
	resetRehearsalDeviceSessions,
	routeRehearsal,
} from './rehearsal-routes.ts'

const origin = 'https://kody-branch-x-mock-cloudflare.example.workers.dev'

function call(path: string, init?: RequestInit) {
	const request = new Request(`${origin}${path}`, init)
	return routeRehearsal(request, new URL(request.url))
}

test('echo returns hashes of the secret-bearing headers, never the values', async () => {
	const response = await call(rehearsalEchoPath, {
		headers: {
			[rehearsalSecretHeader]: 'seeded-secret-value',
			Authorization: 'Bearer integration-token',
		},
	})
	const body = (await response?.json()) as {
		sha256: Record<string, string | null>
	}
	expect(body.sha256).toEqual({
		[rehearsalSecretHeader]: await sha256Hex('seeded-secret-value'),
		authorization: await sha256Hex('Bearer integration-token'),
	})
	expect(JSON.stringify(body)).not.toContain('seeded-secret-value')
	const empty = (await (await call(rehearsalEchoPath))?.json()) as {
		sha256: Record<string, string | null>
	}
	expect(empty.sha256).toEqual({
		[rehearsalSecretHeader]: null,
		authorization: null,
	})
})

test('token endpoint mints tokens for a code or refresh token and rejects anything else', async () => {
	for (const body of [
		'grant_type=authorization_code&code=abc&redirect_uri=x',
		'grant_type=refresh_token&refresh_token=rehearsal_rt_1',
	]) {
		const response = await call(rehearsalOauthTokenPath, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body,
		})
		expect(response?.status).toBe(200)
		const payload = (await response?.json()) as Record<string, unknown>
		expect(payload).toMatchObject({
			access_token: expect.stringMatching(/^rehearsal_at_[0-9a-f]{48}$/),
			refresh_token: expect.stringMatching(/^rehearsal_rt_[0-9a-f]{48}$/),
			token_type: 'bearer',
			expires_in: 3600,
		})
	}
	const rejected = await call(rehearsalOauthTokenPath, {
		method: 'POST',
		body: 'grant_type=client_credentials',
	})
	expect(rejected?.status).toBe(400)
})

async function startDevice(scenario?: string) {
	resetRehearsalDeviceSessions()
	const body = new URLSearchParams({
		client_id: 'rehearsal-client',
		...(scenario ? { scenario } : {}),
	})
	const response = await call(rehearsalOauthDeviceAuthorizePath, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString(),
	})
	expect(response?.status).toBe(200)
	return (await response?.json()) as {
		device_code: string
		user_code: string
		verification_uri: string
		expires_in: number
		interval: number
	}
}

async function pollDevice(deviceCode: string) {
	const response = await call(rehearsalOauthTokenPath, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: DEVICE_CODE_GRANT_TYPE,
			device_code: deviceCode,
			client_id: 'rehearsal-client',
		}).toString(),
	})
	return {
		status: response?.status ?? 0,
		body: (await response?.json()) as Record<string, unknown>,
	}
}

test('device authorize then pending polls succeed', async () => {
	const started = await startDevice('default')
	expect(started.user_code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
	expect(started.device_code).toMatch(/^rehearsal_dc_/)
	const first = await pollDevice(started.device_code)
	expect(first.body.error).toBe('authorization_pending')
	const second = await pollDevice(started.device_code)
	expect(second.body.error).toBe('authorization_pending')
	const third = await pollDevice(started.device_code)
	expect(third.status).toBe(200)
	expect(third.body.access_token).toMatch(/^rehearsal_at_/)
})

test('device slow_down then pending then success', async () => {
	const started = await startDevice('slow_down')
	const first = await pollDevice(started.device_code)
	expect(first.body.error).toBe('slow_down')
	const second = await pollDevice(started.device_code)
	expect(second.body.error).toBe('authorization_pending')
	const third = await pollDevice(started.device_code)
	expect(third.status).toBe(200)
	expect(third.body.access_token).toMatch(/^rehearsal_at_/)
})

test('device access_denied', async () => {
	const started = await startDevice('access_denied')
	const first = await pollDevice(started.device_code)
	expect(first.body.error).toBe('access_denied')
})

test('device expired_token', async () => {
	const started = await startDevice('expired_token')
	const first = await pollDevice(started.device_code)
	expect(first.body.error).toBe('expired_token')
})
