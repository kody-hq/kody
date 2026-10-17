import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	DEVICE_DEFAULT_INTERVAL_SECONDS,
	DEVICE_SLOW_DOWN_INCREMENT_SECONDS,
	pollDeviceAuthorization,
	startDeviceAuthorization,
} from './device-flow.ts'

function createSqliteEnv() {
	const { kv } = createMemoryKvNamespace()
	const sqlite = new DatabaseSync(':memory:')
	return {
		OAUTH_KV: kv,
		APP_DB: createD1FromSqlite(sqlite),
	} as Pick<Env, 'OAUTH_KV' | 'APP_DB'>
}

const baseStart = {
	userId: 'user-device-1',
	deviceAuthorizationUrl: 'https://auth.example.com/device',
	tokenUrl: 'https://auth.example.com/token',
	apiBaseUrl: 'https://api.example.com',
	authorizeUrl: null as string | null,
	clientId: 'client-1',
	clientSecret: null as string | null,
	scopes: ['read'],
	scopeSeparator: ' ' as string | null,
	extraAuthorizeParams: {} as Record<string, string>,
	allowedHosts: ['auth.example.com', 'api.example.com'],
	provider: 'example-device',
	platformAppSlug: null as string | null,
	usePkce: null as boolean | null,
	tokenExchangeStyle: null,
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

test('startDeviceAuthorization stores session and returns user-facing fields without device_code', async () => {
	const env = createSqliteEnv()
	const fetchImpl = vi.fn(async () =>
		jsonResponse({
			device_code: 'secret-device-code',
			user_code: 'ABCD-EFGH',
			verification_uri: 'https://auth.example.com/verify',
			verification_uri_complete:
				'https://auth.example.com/verify?user_code=ABCD-EFGH',
			expires_in: 600,
			interval: 5,
		}),
	)
	const started = await startDeviceAuthorization({
		env,
		...baseStart,
		fetchImpl,
	})
	expect(started.ok).toBe(true)
	if (!started.ok) return
	expect(started.userCode).toBe('ABCD-EFGH')
	expect(started.verificationUri).toBe('https://auth.example.com/verify')
	expect(started.interval).toBe(5)
	expect(JSON.stringify(started)).not.toContain('secret-device-code')
	expect(fetchImpl).toHaveBeenCalledOnce()
})

test('pollDeviceAuthorization walks pending, slow_down (+5s), and success', async () => {
	const env = createSqliteEnv()
	const fetchImpl = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				device_code: 'dc-1',
				user_code: 'CODE-0001',
				verification_uri: 'https://auth.example.com/verify',
				expires_in: 600,
				interval: 5,
			}),
		)
		.mockResolvedValueOnce(
			jsonResponse({ error: 'authorization_pending' }, 400),
		)
		.mockResolvedValueOnce(jsonResponse({ error: 'slow_down' }, 400))
		.mockResolvedValueOnce(
			jsonResponse({
				access_token: 'at-1',
				refresh_token: 'rt-1',
				token_type: 'bearer',
				expires_in: 3600,
			}),
		)

	const started = await startDeviceAuthorization({
		env,
		...baseStart,
		fetchImpl,
	})
	expect(started.ok).toBe(true)
	if (!started.ok) return

	const pending = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: started.sessionId,
		fetchImpl,
		nowMs: Date.now() + 10_000,
	})
	expect(pending.ok).toBe(true)
	if (!pending.ok) return
	expect(pending.status).toBe('authorization_pending')
	if (pending.status !== 'authorization_pending') return
	expect(pending.interval).toBe(DEVICE_DEFAULT_INTERVAL_SECONDS)

	const slowed = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: started.sessionId,
		fetchImpl,
		nowMs: Date.now() + 60_000,
	})
	expect(slowed.ok).toBe(true)
	if (!slowed.ok) return
	expect(slowed.status).toBe('slow_down')
	if (slowed.status !== 'slow_down') return
	expect(slowed.interval).toBe(
		DEVICE_DEFAULT_INTERVAL_SECONDS + DEVICE_SLOW_DOWN_INCREMENT_SECONDS,
	)

	const enforced = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: started.sessionId,
		fetchImpl,
		nowMs: Date.now() + 60_000,
	})
	expect(enforced.ok).toBe(true)
	if (!enforced.ok) return
	expect(enforced.status).toBe('authorization_pending')
	if (enforced.status !== 'authorization_pending') return
	// Interval gate: no extra provider call while nextPollAtMs is in the future.
	expect(fetchImpl).toHaveBeenCalledTimes(3)

	const approved = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: started.sessionId,
		fetchImpl,
		nowMs: Date.now() + 120_000,
	})
	expect(approved.ok).toBe(true)
	if (!approved.ok) return
	expect(approved.status).toBe('approved')
	if (approved.status !== 'approved') return
	expect(approved.tokenPayload.access_token).toBe('at-1')
	expect(JSON.stringify(approved)).not.toContain('dc-1')
})

test('pollDeviceAuthorization returns access_denied and expired_token', async () => {
	const env = createSqliteEnv()
	const fetchDenied = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				device_code: 'dc-deny',
				user_code: 'DENY-0001',
				verification_uri: 'https://auth.example.com/verify',
				expires_in: 600,
				interval: 1,
			}),
		)
		.mockResolvedValueOnce(jsonResponse({ error: 'access_denied' }, 400))
	const deniedStart = await startDeviceAuthorization({
		env,
		...baseStart,
		provider: 'deny-provider',
		fetchImpl: fetchDenied,
	})
	expect(deniedStart.ok).toBe(true)
	if (!deniedStart.ok) return
	const denied = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: deniedStart.sessionId,
		fetchImpl: fetchDenied,
		nowMs: Date.now() + 5_000,
	})
	expect(denied.ok).toBe(false)
	if (denied.ok) return
	expect(denied.status).toBe('access_denied')

	const fetchExpired = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				device_code: 'dc-exp',
				user_code: 'EXPI-0001',
				verification_uri: 'https://auth.example.com/verify',
				expires_in: 600,
				interval: 1,
			}),
		)
		.mockResolvedValueOnce(jsonResponse({ error: 'expired_token' }, 400))
	const expiredStart = await startDeviceAuthorization({
		env,
		...baseStart,
		provider: 'expire-provider',
		fetchImpl: fetchExpired,
	})
	expect(expiredStart.ok).toBe(true)
	if (!expiredStart.ok) return
	const expired = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: expiredStart.sessionId,
		fetchImpl: fetchExpired,
		nowMs: Date.now() + 5_000,
	})
	expect(expired.ok).toBe(false)
	if (expired.ok) return
	expect(expired.status).toBe('expired_token')
})

test('pollDeviceAuthorization enforces interval without hitting the provider', async () => {
	const env = createSqliteEnv()
	const fetchImpl = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse({
				device_code: 'dc-interval',
				user_code: 'INTV-0001',
				verification_uri: 'https://auth.example.com/verify',
				expires_in: 600,
				interval: 10,
			}),
		)
		.mockResolvedValueOnce(
			jsonResponse({ error: 'authorization_pending' }, 400),
		)
	const started = await startDeviceAuthorization({
		env,
		...baseStart,
		provider: 'interval-provider',
		fetchImpl,
	})
	expect(started.ok).toBe(true)
	if (!started.ok) return
	const t0 = Date.now() + 20_000
	const first = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: started.sessionId,
		fetchImpl,
		nowMs: t0,
	})
	expect(first.ok && first.status === 'authorization_pending').toBe(true)
	expect(fetchImpl).toHaveBeenCalledTimes(2)
	const second = await pollDeviceAuthorization({
		env,
		userId: baseStart.userId,
		sessionId: started.sessionId,
		fetchImpl,
		nowMs: t0 + 1_000,
	})
	expect(second.ok && second.status === 'authorization_pending').toBe(true)
	expect(fetchImpl).toHaveBeenCalledTimes(2)
})
