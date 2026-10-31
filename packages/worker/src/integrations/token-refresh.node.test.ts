import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createD1FromSqlite,
	type CreateD1FromSqliteOptions,
} from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	persistIntegrationTokens,
	persistUserOauthAppClientSecret,
	resolveIntegrationAccessToken,
	resolveIntegrationRefreshToken,
} from './credentials.ts'
import { upsertPlatformOauthApp } from './platform-apps.ts'
import { inferIntegrationRefreshPolicy } from './refresh-policy.ts'
import { writeIntegrationAuthFailure } from './repo.ts'
import {
	getJoinedIntegration,
	upsertIntegration,
	upsertPlatformIntegration,
} from './service.ts'

const mocks = vi.hoisted(() => ({
	dispatchIntegrationAuthFailedSubscriptionEvents: vi.fn(async () => []),
	dispatchIntegrationAuthSucceededSubscriptionEvents: vi.fn(async () => []),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchIntegrationAuthFailedSubscriptionEvents:
		mocks.dispatchIntegrationAuthFailedSubscriptionEvents,
	dispatchIntegrationAuthSucceededSubscriptionEvents:
		mocks.dispatchIntegrationAuthSucceededSubscriptionEvents,
	integrationAuthFailedTopic: 'integration.auth.failed',
	integrationAuthSucceededTopic: 'integration.auth.succeeded',
}))

const {
	IntegrationTokenRefreshCallerError,
	integrationTokenRefreshCallerMarker,
	refreshIntegrationTokens,
} = await import('./token-refresh.ts')

const migrationsDirectory = new URL('../../migrations/', import.meta.url)
const failedEvents = mocks.dispatchIntegrationAuthFailedSubscriptionEvents
const succeededEvents = mocks.dispatchIntegrationAuthSucceededSubscriptionEvents

function createHarness(d1Options: CreateD1FromSqliteOptions = {}) {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const env = {
		APP_DB: createD1FromSqlite(sqlite, d1Options),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	return { sqlite, env }
}

const platformApps = {
	github: {
		slug: 'github',
		clientId: 'platform-github-client-id',
		clientSecret: 'platform-github-client-secret-value',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		authorizeUrl: 'https://github.com/login/oauth/authorize',
		apiBaseUrl: 'https://api.github.com',
		flow: 'confidential' as const,
	},
	google: {
		slug: 'google',
		clientId: 'platform-google-client-id',
		clientSecret: 'platform-google-client-secret-value',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		apiBaseUrl: 'https://www.googleapis.com',
		flow: 'confidential' as const,
	},
}

async function seedPlatformConnection(
	env: Env,
	userId: string,
	slug: keyof typeof platformApps,
	extra: {
		app?: Partial<Parameters<typeof upsertPlatformOauthApp>[0]['app']>
		scopes?: Array<string>
	} = {},
) {
	await upsertPlatformOauthApp({
		db: env.APP_DB,
		env,
		app: { ...platformApps[slug], ...extra.app },
	})
	await upsertPlatformIntegration({
		env,
		userId,
		platformAppSlug: slug,
		scopes: extra.scopes ?? [],
		audit: null,
	})
	await seedUserTokens(env, userId, slug)
}

async function readAuthFailure(env: Env, userId: string, name: string) {
	return env.APP_DB.prepare(
		`SELECT auth_failed_reason, auth_failed_reconnectable, auth_failed_http_status
		 FROM user_integrations
		 WHERE user_id = ? AND name = ?
		 LIMIT 1`,
	)
		.bind(userId, name)
		.first<{
			auth_failed_reason: string | null
			auth_failed_reconnectable: number | null
			auth_failed_http_status: number | null
		}>()
}

async function seedUserTokens(env: Env, userId: string, name: string) {
	await persistIntegrationTokens({
		env,
		userId: ownerIdFromStored(userId),
		name,
		accessToken: 'stale-access-token',
		refreshToken: 'current-refresh-token',
		refreshPolicy: 'required',
		audit: null,
	})
}

function jsonResponse(payload: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function stubTokenEndpoint(payload: Record<string, unknown>) {
	const fetchMock = vi.fn(async () => jsonResponse(payload))
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

function isCallerError(reason: string, ...messageParts: Array<string>) {
	return (error: unknown) =>
		error instanceof IntegrationTokenRefreshCallerError &&
		error.reason === reason &&
		messageParts.every((part) => error.message.includes(part))
}

test('platform-lane refresh uses the decrypted shared client secret and persists tokens', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-platform-refresh')
	const tokens = { env, userId, name: 'github' }
	await seedPlatformConnection(env, userId, 'github')

	const fetchMock = stubTokenEndpoint({
		access_token: 'fresh-access-token',
		refresh_token: 'rotated-refresh-token',
	})
	try {
		const result = await refreshIntegrationTokens(tokens)
		expect(result.refreshTokenRotated).toBe(true)
		expect(JSON.stringify(result)).not.toContain('fresh-access-token')
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const [tokenUrl, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(tokenUrl).toBe('https://github.com/login/oauth/access_token')
		const body = String(init.body)
		for (const part of [
			'grant_type=refresh_token',
			'refresh_token=current-refresh-token',
			'client_id=platform-github-client-id',
			'client_secret=platform-github-client-secret-value',
		]) {
			expect(body).toContain(part)
		}
		expect((await resolveIntegrationAccessToken(tokens))?.accessToken).toBe(
			'fresh-access-token',
		)
		expect(await resolveIntegrationRefreshToken(tokens)).toBe(
			'rotated-refresh-token',
		)
		expect(failedEvents).not.toHaveBeenCalled()
		expect(succeededEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				source: 'refresh',
				integration: expect.objectContaining({
					name: 'github',
					lane: 'platform',
				}),
			}),
		)
		const cleared = {
			auth_failed_reason: null,
			auth_failed_reconnectable: null,
		}
		expect(await readAuthFailure(env, userId, 'github')).toMatchObject(cleared)

		const afterRefresh = await getJoinedIntegration(tokens)
		expect(afterRefresh?.connection.tokenRefreshedAt).toEqual(
			expect.stringMatching(/^\d{4}-/),
		)
		const writeFailure = (expectedTokenRefreshedAt: string | null) =>
			writeIntegrationAuthFailure({
				db: env.APP_DB,
				userId,
				name: 'github',
				reason: 'provider_rejected',
				reconnectable: true,
				expectedTokenRefreshedAt,
			})
		await writeFailure('2020-01-01T00:00:00.000Z')
		expect(await readAuthFailure(env, userId, 'github')).toMatchObject(cleared)
		await writeFailure(afterRefresh?.connection.tokenRefreshedAt ?? null)
		expect(await readAuthFailure(env, userId, 'github')).toMatchObject({
			auth_failed_reason: 'provider_rejected',
			auth_failed_reconnectable: 1,
		})
	} finally {
		vi.unstubAllGlobals()
	}

	failedEvents.mockClear()
	succeededEvents.mockClear()
	await expect(
		refreshIntegrationTokens({ ...tokens, name: 'missing-connection' }),
	).rejects.toSatisfy(isCallerError('not_found'))
	expect(failedEvents).not.toHaveBeenCalled()
	expect(succeededEvents).not.toHaveBeenCalled()

	await upsertPlatformIntegration({
		env,
		userId: ownerIdFromStored('user-no-refresh'),
		platformAppSlug: 'github',
		scopes: [],
		audit: null,
	})
	await expect(
		refreshIntegrationTokens({
			...tokens,
			userId: ownerIdFromStored('user-no-refresh'),
		}),
	).rejects.toSatisfy(
		isCallerError(
			'missing_refresh_token',
			'does not have a stored refresh token',
			'/connect/oauth?provider=github',
			integrationTokenRefreshCallerMarker,
		),
	)
	expect(failedEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-no-refresh'),
			reason: 'missing_refresh_token',
			integration: expect.objectContaining({
				name: 'github',
				lane: 'platform',
			}),
		}),
	)
	expect(await readAuthFailure(env, 'user-no-refresh', 'github')).toMatchObject(
		{
			auth_failed_reason: 'missing_refresh_token',
			auth_failed_reconnectable: 1,
		},
	)
})

test('provider HTTP status classifies refresh failures as caller errors or Sentry-visible Errors', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-google-provider-status')
	await seedPlatformConnection(env, userId, 'google')
	const fetchMock = vi
		.fn()
		.mockResolvedValueOnce(
			jsonResponse(
				{
					error: 'invalid_grant',
					error_description: 'Token has been expired or revoked.',
				},
				400,
			),
		)
		.mockResolvedValueOnce(jsonResponse({ error: 'server_error' }, 503))
		.mockResolvedValueOnce(jsonResponse({ access_token: '' }))
	vi.stubGlobal('fetch', fetchMock)
	try {
		const waitUntil = vi.fn()
		await expect(
			refreshIntegrationTokens({ env, userId, name: 'google', waitUntil }),
		).rejects.toSatisfy(
			(error: unknown) =>
				isCallerError(
					'provider_rejected',
					'HTTP 400',
					'invalid_grant',
					'/connect/oauth?provider=google',
					integrationTokenRefreshCallerMarker,
				)(error) &&
				error instanceof IntegrationTokenRefreshCallerError &&
				error.providerError === 'invalid_grant' &&
				error.httpStatus === 400,
		)
		expect(waitUntil).toHaveBeenCalledTimes(1)
		await waitUntil.mock.calls[0]?.[0]
		expect(failedEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				reason: 'provider_rejected',
				provider: {
					error: 'invalid_grant',
					error_description: 'Token has been expired or revoked.',
					http_status: 400,
				},
			}),
		)
		expect(await readAuthFailure(env, userId, 'google')).toMatchObject({
			auth_failed_reason: 'provider_rejected',
			auth_failed_reconnectable: 1,
			auth_failed_http_status: 400,
		})

		failedEvents.mockClear()
		await expect(
			refreshIntegrationTokens({ env, userId, name: 'google' }),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error &&
				!(error instanceof IntegrationTokenRefreshCallerError) &&
				error.message.includes('HTTP 503'),
		)
		expect(failedEvents).not.toHaveBeenCalled()
		expect(await readAuthFailure(env, userId, 'google')).toMatchObject({
			auth_failed_reason: 'provider_unavailable',
			auth_failed_reconnectable: 0,
			auth_failed_http_status: 503,
		})

		await expect(
			refreshIntegrationTokens({ env, userId, name: 'google' }),
		).rejects.toSatisfy(
			isCallerError('provider_rejected', 'did not return an access_token'),
		)
		expect(failedEvents).toHaveBeenCalledWith(
			expect.objectContaining({ reason: 'provider_rejected' }),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('user-lane refresh resolves the ciphertext client secret and enforces required hosts', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-lane-refresh')
	const googleConfig = {
		name: 'google',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		flow: 'confidential' as const,
		clientId: 'user-google-client-id',
		requiredHosts: ['www.googleapis.com'],
		authorization: {
			authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			scopes: ['openid'],
			scopeSeparator: null,
			extraAuthorizeParams: {},
		},
	}
	await upsertIntegration({ env, userId, config: googleConfig, audit: null })
	await persistUserOauthAppClientSecret({
		env,
		userId,
		slug: 'google',
		value: 'user-google-client-secret',
	})
	await seedUserTokens(env, userId, 'google')

	const fetchMock = stubTokenEndpoint({ access_token: 'fresh-google-token' })
	try {
		await expect(
			refreshIntegrationTokens({ env, userId, name: 'google' }),
		).rejects.toSatisfy(
			isCallerError(
				'host_not_approved',
				'Integration "google" is not approved for host "oauth2.googleapis.com"',
				integrationTokenRefreshCallerMarker,
			),
		)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(failedEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'host_not_approved',
				integration: expect.objectContaining({ name: 'google', lane: 'user' }),
			}),
		)

		await upsertIntegration({
			env,
			userId,
			config: {
				...googleConfig,
				requiredHosts: ['www.googleapis.com', 'oauth2.googleapis.com'],
			},
			audit: null,
		})
		const result = await refreshIntegrationTokens({
			env,
			userId,
			name: 'google',
		})
		expect(result.refreshTokenRotated).toBe(false)
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
		expect(String(init.body)).toContain(
			'client_secret=user-google-client-secret',
		)
		expect(
			(await resolveIntegrationAccessToken({ env, userId, name: 'google' }))
				?.accessToken,
		).toBe('fresh-google-token')
		expect(succeededEvents).toHaveBeenCalledWith(
			expect.objectContaining({
				userId,
				source: 'refresh',
				integration: expect.objectContaining({ name: 'google', lane: 'user' }),
			}),
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('successful Google refresh persists userinfo email as account_label when missing', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-google-label')
	await seedPlatformConnection(env, userId, 'google', {
		app: {
			requiredHosts: ['oauth2.googleapis.com', 'openidconnect.googleapis.com'],
			allowedScopes: ['openid', 'email'],
			defaultScopes: ['openid', 'email'],
		},
		scopes: ['openid', 'email'],
	})
	const fetchMock = vi.fn(async (url: string | URL | Request) =>
		String(url).includes('openidconnect.googleapis.com')
			? jsonResponse({ email: 'kent.c.dodds@gmail.com' })
			: jsonResponse({ access_token: 'fresh-google-token' }),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		await refreshIntegrationTokens({ env, userId, name: 'google' })
		const joined = await getJoinedIntegration({ env, userId, name: 'google' })
		expect(joined?.connection.accountLabel).toBe('kent.c.dodds@gmail.com')
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await upsertPlatformIntegration({
			env,
			userId,
			platformAppSlug: 'google',
			scopes: ['openid', 'email'],
			accountLabel: 'Work',
			audit: null,
		})
		await refreshIntegrationTokens({ env, userId, name: 'google' })
		const labeled = await getJoinedIntegration({ env, userId, name: 'google' })
		expect(labeled?.connection.accountLabel).toBe('Work')
		expect(fetchMock).toHaveBeenCalledTimes(3)
		expect(
			fetchMock.mock.calls.filter(([url]) =>
				String(url).includes('openidconnect.googleapis.com'),
			),
		).toHaveLength(1)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('in-flight refreshes of the same connection share one provider POST and one succeeded emit', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-coalesce-refresh')
	await seedPlatformConnection(env, userId, 'github')
	let releaseTokenEndpoint: () => void = () => {}
	const tokenEndpointOpened = new Promise<void>((resolve) => {
		releaseTokenEndpoint = resolve
	})
	const fetchMock = vi.fn(async (url: string | URL | Request) => {
		if (!String(url).includes('login/oauth/access_token')) {
			throw new Error(`unexpected fetch ${String(url)}`)
		}
		await tokenEndpointOpened
		return jsonResponse({
			access_token: 'fresh-access-token',
			refresh_token: 'rotated-refresh-token',
		})
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		const first = refreshIntegrationTokens({ env, userId, name: 'github' })
		const second = refreshIntegrationTokens({ env, userId, name: 'github' })
		await expect.poll(() => fetchMock.mock.calls.length).toBe(1)
		releaseTokenEndpoint()
		const [firstResult, secondResult] = await Promise.all([first, second])
		expect(firstResult).toEqual(secondResult)
		expect(firstResult.refreshTokenRotated).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(succeededEvents).toHaveBeenCalledTimes(1)

		await refreshIntegrationTokens({ env, userId, name: 'github' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(succeededEvents).toHaveBeenCalledTimes(2)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('concurrent refreshes from separate isolates make one rotating provider call and keep the newest refresh token', async () => {
	const queries: Array<string> = []
	const { env } = createHarness({ queries })
	const userId = ownerIdFromStored('user-cross-isolate-refresh')
	const tokens = { env, userId, name: 'github' }
	await seedPlatformConnection(env, userId, 'github')
	vi.resetModules()
	const otherIsolate = await import('./token-refresh.ts')
	expect(otherIsolate.refreshIntegrationTokens).not.toBe(
		refreshIntegrationTokens,
	)

	let releaseTokenEndpoint: () => void = () => {}
	const tokenEndpointOpened = new Promise<void>((resolve) => {
		releaseTokenEndpoint = resolve
	})
	let rotation = 0
	const fetchMock = vi.fn(async () => {
		await tokenEndpointOpened
		rotation += 1
		return jsonResponse({
			access_token: `fresh-access-token-${rotation}`,
			refresh_token: `rotated-refresh-token-${rotation}`,
		})
	})
	vi.stubGlobal('fetch', fetchMock)
	const leaseClaims = () => countLeaseClaims(queries)
	try {
		const first = refreshIntegrationTokens(tokens)
		await expect.poll(() => fetchMock.mock.calls.length).toBe(1)
		const second = otherIsolate.refreshIntegrationTokens(tokens)
		await expect
			.poll(() => fetchMock.mock.calls.length > 1 || leaseClaims() >= 2)
			.toBe(true)
		releaseTokenEndpoint()
		const [firstResult, secondResult] = await Promise.all([first, second])

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(firstResult).toMatchObject({
			refreshed: true,
			refreshTokenRotated: true,
		})
		expect(secondResult).toEqual({
			refreshed: true,
			refreshedAt: firstResult.refreshedAt,
			refreshTokenRotated: false,
		})
		expect(await resolveIntegrationRefreshToken(tokens)).toBe(
			'rotated-refresh-token-1',
		)
		expect((await resolveIntegrationAccessToken(tokens))?.accessToken).toBe(
			'fresh-access-token-1',
		)
		expect(succeededEvents).toHaveBeenCalledTimes(1)

		await otherIsolate.refreshIntegrationTokens(tokens)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		const [, nextInit] = fetchMock.mock.calls[1] as unknown as [
			string,
			RequestInit,
		]
		expect(String(nextInit.body)).toContain(
			'refresh_token=rotated-refresh-token-1',
		)
		expect(await resolveIntegrationRefreshToken(tokens)).toBe(
			'rotated-refresh-token-2',
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

function countLeaseClaims(queries: Array<string>) {
	return queries.filter((query) =>
		query.includes('SET token_refresh_lease_id = ?'),
	).length
}

test('a refresher whose lease was taken over cannot overwrite the stored tokens', async () => {
	const { sqlite, env } = createHarness()
	const userId = ownerIdFromStored('user-lease-fence')
	const tokens = { env, userId, name: 'github' }
	await seedPlatformConnection(env, userId, 'github')
	const fetchMock = vi.fn(async () => {
		sqlite
			.prepare(
				`UPDATE user_integrations
				SET token_refresh_lease_id = 'newer-holder'
				WHERE user_id = ? AND name = 'github'`,
			)
			.run(userId)
		return jsonResponse({
			access_token: 'late-access-token',
			refresh_token: 'late-refresh-token',
		})
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		await expect(refreshIntegrationTokens(tokens)).rejects.toThrow(
			'expired before its tokens were saved',
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await resolveIntegrationRefreshToken(tokens)).toBe(
			'current-refresh-token',
		)
		expect((await resolveIntegrationAccessToken(tokens))?.accessToken).toBe(
			'stale-access-token',
		)
		expect(
			sqlite
				.prepare(
					`SELECT token_refresh_lease_id FROM user_integrations
					WHERE user_id = ? AND name = 'github'`,
				)
				.get(userId),
		).toEqual({ token_refresh_lease_id: 'newer-holder' })
		expect(succeededEvents).not.toHaveBeenCalled()
	} finally {
		vi.unstubAllGlobals()
	}
})

test('a reconnect during an in-flight refresh keeps the reconnected tokens', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-reconnect-mid-refresh')
	const tokens = { env, userId, name: 'github' }
	await seedPlatformConnection(env, userId, 'github')
	const fetchMock = vi.fn(async () => {
		await persistIntegrationTokens({
			env,
			userId,
			name: 'github',
			accessToken: 'reconnected-access-token',
			refreshToken: 'reconnected-refresh-token',
			refreshPolicy: 'required',
			audit: null,
		})
		return jsonResponse({
			access_token: 'old-grant-access-token',
			refresh_token: 'old-grant-refresh-token',
		})
	})
	vi.stubGlobal('fetch', fetchMock)
	try {
		await expect(refreshIntegrationTokens(tokens)).rejects.toThrow(
			'expired before its tokens were saved',
		)
		expect(await resolveIntegrationRefreshToken(tokens)).toBe(
			'reconnected-refresh-token',
		)
		expect((await resolveIntegrationAccessToken(tokens))?.accessToken).toBe(
			'reconnected-access-token',
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('a refresh waiting on the lease does not refresh the old grant over a reconnect', async () => {
	const queries: Array<string> = []
	const { sqlite, env } = createHarness({ queries })
	const userId = ownerIdFromStored('user-reconnect-while-waiting')
	const tokens = { env, userId, name: 'github' }
	await seedPlatformConnection(env, userId, 'github')
	sqlite
		.prepare(
			`UPDATE user_integrations
			SET token_refresh_lease_id = 'other-holder',
				token_refresh_lease_expires_at = '2999-01-01T00:00:00.000Z'
			WHERE user_id = ? AND name = 'github'`,
		)
		.run(userId)
	const fetchMock = stubTokenEndpoint({
		access_token: 'old-grant-access-token',
		refresh_token: 'old-grant-refresh-token',
	})
	try {
		const refresh = refreshIntegrationTokens(tokens)
		await expect.poll(() => countLeaseClaims(queries)).toBeGreaterThan(0)
		// The reconnect returns no refresh token, so the stored one stays.
		await persistIntegrationTokens({
			env,
			userId,
			name: 'github',
			accessToken: 'reconnected-access-token',
			refreshToken: null,
			refreshPolicy: 'required',
			audit: null,
		})
		await expect(refresh).resolves.toMatchObject({ refreshed: true })
		expect(fetchMock).not.toHaveBeenCalled()
		expect((await resolveIntegrationAccessToken(tokens))?.accessToken).toBe(
			'reconnected-access-token',
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('a waiter whose connection was replaced mid-wait re-reads it and refreshes instead of stalling', async () => {
	const queries: Array<string> = []
	const { sqlite, env } = createHarness({ queries })
	const userId = ownerIdFromStored('user-lease-replaced')
	const tokens = { env, userId, name: 'github' }
	await seedPlatformConnection(env, userId, 'github')
	sqlite
		.prepare(
			`UPDATE user_integrations
			SET token_refreshed_at = '2026-01-01T00:00:00.000Z',
				token_refresh_lease_id = 'old-connection-holder',
				token_refresh_lease_expires_at = '2999-01-01T00:00:00.000Z'
			WHERE user_id = ? AND name = 'github'`,
		)
		.run(userId)
	const fetchMock = stubTokenEndpoint({
		access_token: 'fresh-access-token',
		refresh_token: 'rotated-refresh-token',
	})
	try {
		const refresh = refreshIntegrationTokens(tokens)
		await expect.poll(() => countLeaseClaims(queries)).toBe(1)
		sqlite
			.prepare(
				`UPDATE user_integrations
				SET token_refreshed_at = NULL,
					token_refresh_lease_id = NULL,
					token_refresh_lease_expires_at = NULL
				WHERE user_id = ? AND name = 'github'`,
			)
			.run(userId)
		await expect(refresh).resolves.toMatchObject({
			refreshed: true,
			refreshTokenRotated: true,
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await resolveIntegrationRefreshToken(tokens)).toBe(
			'rotated-refresh-token',
		)
	} finally {
		vi.unstubAllGlobals()
	}
})

test('refresh policy follows each connect: non-expiring grants skip refresh, expiring grants without a refresh token still wait', async () => {
	const { env } = createHarness()
	const userId = ownerIdFromStored('user-refresh-policy')
	const name = 'github-kent'
	await upsertIntegration({
		env,
		userId,
		config: {
			name,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			flow: 'pkce' as const,
			clientId: 'kent-github-client-id',
			requiredHosts: ['api.github.com', 'github.com'],
		},
		audit: null,
	})
	const connect = (tokenPayload: Record<string, unknown>) =>
		persistIntegrationTokens({
			env,
			userId,
			name,
			accessToken: String(tokenPayload.access_token),
			refreshToken:
				typeof tokenPayload.refresh_token === 'string'
					? tokenPayload.refresh_token
					: null,
			refreshPolicy: inferIntegrationRefreshPolicy(tokenPayload),
			audit: null,
		})
	const writeFailure = (
		reason: 'missing_refresh_token' | 'provider_rejected',
	) =>
		writeIntegrationAuthFailure({
			db: env.APP_DB,
			userId,
			name,
			reason,
			reconnectable: true,
			expectedTokenRefreshedAt: null,
		})
	const readConnection = async () =>
		(await getJoinedIntegration({ env, userId, name }))?.connection

	await connect({
		access_token: 'gho_non_expiring',
		token_type: 'bearer',
		scope: 'repo',
	})
	await writeFailure('missing_refresh_token')
	expect(await readConnection()).toMatchObject({
		refreshPolicy: 'not_applicable',
		lastAuthFailure: null,
	})

	const fetchMock = vi.fn(async () =>
		jsonResponse({
			access_token: 'ghu_refreshed',
			refresh_token: 'ghr_rotated',
			expires_in: 28_800,
		}),
	)
	vi.stubGlobal('fetch', fetchMock)
	try {
		await expect(
			refreshIntegrationTokens({ env, userId, name }),
		).resolves.toEqual({
			refreshed: false,
			skippedReason: 'refresh_not_applicable',
			refreshedAt: null,
			refreshTokenRotated: false,
		})
		expect(fetchMock).not.toHaveBeenCalled()
		expect(failedEvents).not.toHaveBeenCalled()
		expect(succeededEvents).not.toHaveBeenCalled()
		expect((await readConnection())?.lastAuthFailure).toBeNull()

		await writeFailure('provider_rejected')
		expect((await readConnection())?.lastAuthFailure).toMatchObject({
			reason: 'provider_rejected',
			reconnectable: true,
		})

		await connect({ access_token: 'ghu_expiring', expires_in: 28_800 })
		expect(await readConnection()).toMatchObject({
			refreshPolicy: 'required',
			lastAuthFailure: null,
		})
		await expect(
			refreshIntegrationTokens({ env, userId, name }),
		).rejects.toSatisfy(isCallerError('missing_refresh_token'))
		expect(fetchMock).not.toHaveBeenCalled()
		expect(failedEvents).toHaveBeenCalledWith(
			expect.objectContaining({ userId, reason: 'missing_refresh_token' }),
		)
		expect((await readConnection())?.lastAuthFailure).toMatchObject({
			reason: 'missing_refresh_token',
			reconnectable: true,
		})

		await connect({
			access_token: 'ghu_expiring_2',
			refresh_token: 'ghr_current',
			expires_in: 28_800,
		})
		await expect(
			refreshIntegrationTokens({ env, userId, name }),
		).resolves.toMatchObject({ refreshed: true, refreshTokenRotated: true })
		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(await readConnection()).toMatchObject({
			refreshPolicy: 'required',
			lastAuthFailure: null,
		})
		expect(
			(await resolveIntegrationAccessToken({ env, userId, name }))?.accessToken,
		).toBe('ghu_refreshed')

		await connect({ access_token: 'gho_non_expiring_again' })
		expect((await readConnection())?.refreshPolicy).toBe('not_applicable')
		expect(await resolveIntegrationRefreshToken({ env, userId, name })).toBe(
			'ghr_rotated',
		)
		await expect(
			refreshIntegrationTokens({ env, userId, name }),
		).resolves.toMatchObject({ refreshed: false })
		expect(fetchMock).toHaveBeenCalledTimes(1)
	} finally {
		vi.unstubAllGlobals()
	}
})
