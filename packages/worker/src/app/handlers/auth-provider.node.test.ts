import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { testAccountConnectionsApiHandler } from '#app/handlers/account-connections.test-support.ts'
import { publicAuthProvidersLoaderData } from '#app/public-auth-providers.ts'
import { emptyPublicFormProtection } from '#universal/public-form-protection.ts'
import { startWebsiteOAuth } from '#worker/identity/oauth-start-operation.ts'
import { reservedUsernamesKvKey } from '#worker/identity/reserved-username-settings.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'
import { getUsernameValidationError } from '#worker/identity/username.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import {
	createAppEnv,
	createMemoryKv,
	createMigratedDb,
	getCookiePair,
	runHandler,
	seedUser,
	startProviderFlow,
	testCookieSecret,
} from '#worker/test-support/auth-provider-harness.ts'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	createPasswordHash,
	verifyPassword,
} from '@kody-internal/shared/password-hash.ts'
import { quoteSqlString } from '@kody-internal/shared/sql-literals.ts'
import { HttpResponse, http } from 'msw'
import { type DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'

const lifecycleMocks = vi.hoisted(() => ({
	scheduleUserCreatedEvent: vi.fn(),
}))

vi.mock('#worker/identity/schedule-user-lifecycle-event.ts', () => ({
	scheduleUserCreatedEvent: (...args: Array<unknown>) =>
		lifecycleMocks.scheduleUserCreatedEvent(...args),
	scheduleUserDeletedEvent: vi.fn(),
}))

const { createAuthProviderCallbackHandler } =
	await import('#app/handlers/auth-provider.ts')

const msw = createMswNodeServer()

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

afterEach(() => {
	msw.resetHandlers()
})

afterAll(() => {
	msw.close()
})

type Provider = 'github' | 'google' | 'x' | 'discord'

async function completeProviderFlow(
	env: Env,
	provider: Provider,
	options: {
		startUrl?: string
		cookie?: string
		query?: string
		mockMode?: boolean
	} = {},
) {
	const start = await startProviderFlow(
		env,
		provider,
		options.startUrl ?? `http://example.com/auth/${provider}`,
	)
	const url = options.mockMode
		? start.location
		: `http://example.com/auth/${provider}/callback?${options.query ?? `code=${provider}-auth-code`}&state=${start.state}`
	const cookie = options.cookie
		? `${start.stateCookie}; ${options.cookie}`
		: start.stateCookie
	const response = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(url, { headers: { Cookie: cookie } }),
		{ provider },
	)
	return { start, response }
}

async function sessionCookieFor(email: string) {
	return getCookiePair(
		await createAuthCookie(
			{
				stableUserId: testStableUserIdFromEmail(email),
				email,
				rememberMe: false,
			},
			false,
		),
	)
}

function sessionCookieFrom(response: Response) {
	const pair = response.headers
		.getSetCookie()
		.map(getCookiePair)
		.find((cookie) => cookie.startsWith('kody_session='))
	expect(pair).toBeTruthy()
	return pair ?? ''
}

function setsCookie(response: Response, prefix: string, cleared = false) {
	return response.headers
		.getSetCookie()
		.some(
			(cookie) =>
				cookie.startsWith(prefix) && (!cleared || cookie.includes('Max-Age=0')),
		)
}

function countRows(sqlite: DatabaseSync, table: string, where = '') {
	const row = sqlite
		.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
		.get() as { count: number }
	return row.count
}

function connectionsRequest(cookie: string, body?: Record<string, unknown>) {
	return new Request('http://example.com/account/connections.json', {
		method: body ? 'POST' : 'GET',
		headers: {
			Cookie: cookie,
			Accept: 'application/json',
			...(body ? { 'Content-Type': 'application/json' } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	})
}

function mockGithubProfileExchange(email = 'octo@example.com', id = 99001) {
	msw.use(
		http.post('https://github.com/login/oauth/access_token', async () =>
			HttpResponse.json({ access_token: 'github-access-token' }),
		),
		http.get('https://api.github.com/user', () =>
			HttpResponse.json({
				id,
				login: 'octo-cat',
				name: 'Octo Cat',
				email: null,
			}),
		),
		http.get('https://api.github.com/user/emails', () =>
			HttpResponse.json([{ email, primary: true, verified: true }]),
		),
	)
}

function mockGoogleUserinfo(profile: Record<string, unknown>) {
	msw.use(
		http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
			const body = new URLSearchParams(await request.text())
			expect(body.get('code')).toBe('google-auth-code')
			// Google uses PKCE; the callback replays the verifier from the
			// signed state cookie.
			expect(body.get('code_verifier')?.length).toBeGreaterThan(0)
			return HttpResponse.json({ access_token: 'google-access-token' })
		}),
		http.get('https://openidconnect.googleapis.com/v1/userinfo', () =>
			HttpResponse.json({ email_verified: true, ...profile }),
		),
	)
}

function seedSecondFactors(
	sqlite: DatabaseSync,
	userId: number,
	label: string,
) {
	sqlite.exec(`
		INSERT INTO verifications (
			type, target, secret, algorithm, digits, period, char_set
		) VALUES ('2fa', '${userId}', '${label.toUpperCase()}SECRET', 'SHA-1', 6, 30, '0123456789');
		INSERT INTO passkeys (
			id, aaguid, public_key, user_id, webauthn_user_handle, counter,
			device_type, backed_up, transports, name
		) VALUES (
			'${label}-passkey', '00000000-0000-0000-0000-000000000000', 'cHVibGlj',
			${userId}, 'd2ViYXV0aG4tdXNlcg', 0, 'multiDevice', 1, 'internal', '${label}'
		);
		INSERT INTO oauth_connections (provider_name, provider_id, user_id, provider_display_name)
		VALUES ('github', '${label}-github', ${userId}, '${label}');
	`)
}

test('providers api lists only configured providers', async () => {
	const { db } = createMigratedDb()
	const allEnabled = publicAuthProvidersLoaderData(createAppEnv(db))
	expect(allEnabled).toEqual({
		ok: true,
		turnstileSiteKey: null,
		providers: [
			{ id: 'github', label: 'GitHub' },
			{ id: 'google', label: 'Google' },
			{ id: 'x', label: 'X' },
			{ id: 'discord', label: 'Discord' },
		],
	})

	const githubOnly = publicAuthProvidersLoaderData(
		createAppEnv(db, {
			GOOGLE_CLIENT_ID: '',
			GOOGLE_CLIENT_SECRET: '',
			X_CLIENT_ID: '',
			X_CLIENT_SECRET: '',
			DISCORD_CLIENT_ID: '',
			DISCORD_CLIENT_SECRET: '',
		}),
	)
	expect(githubOnly).toEqual({
		ok: true,
		turnstileSiteKey: null,
		providers: [{ id: 'github', label: 'GitHub' }],
	})
})

test('github sign-in creates a verified account, then signs it back in', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)

	msw.use(
		http.post(
			'https://github.com/login/oauth/access_token',
			async ({ request }) => {
				const body = new URLSearchParams(await request.text())
				expect(body.get('client_id')).toBe('github-client-id-test')
				expect(body.get('client_secret')).toBe('github-client-secret-test')
				expect(body.get('code')).toBe('github-auth-code')
				return HttpResponse.json({ access_token: 'github-access-token' })
			},
		),
		http.get('https://api.github.com/user', ({ request }) => {
			expect(new Headers(request.headers).get('Authorization')).toBe(
				'Bearer github-access-token',
			)
			return HttpResponse.json({
				id: 99001,
				login: 'octo-cat',
				name: 'Octo Cat',
				email: null,
			})
		}),
		http.get('https://api.github.com/user/emails', () =>
			HttpResponse.json([
				{ email: 'unverified@example.com', primary: false, verified: false },
				{ email: 'octo@example.com', primary: true, verified: true },
			]),
		),
	)

	const { start, response: callbackResponse } = await completeProviderFlow(
		env,
		'github',
		{ startUrl: 'http://example.com/auth/github?redirectTo=%2Fcommunity' },
	)
	expect(start.location).toContain('https://github.com/login/oauth/authorize')
	expect(start.location).toContain('client_id=github-client-id-test')
	expect(start.stateCookie).toContain('kody_oauth_login=')
	expect(start.state.length).toBeGreaterThan(0)
	expect(callbackResponse.status).toBe(302)
	// An explicit redirectTo still wins over the new-account onboarding default,
	// and accountCreated=1 is appended so Fathom can record account_created.
	expect(new Headers(callbackResponse.headers).get('Location')).toBe(
		'/community?accountCreated=1',
	)
	expect(setsCookie(callbackResponse, 'kody_session=')).toBe(true)
	// The one-shot state and referral cookies are cleared on the callback.
	expect(setsCookie(callbackResponse, 'kody_oauth_login=', true)).toBe(true)
	expect(setsCookie(callbackResponse, 'kody_ref=', true)).toBe(true)

	const user = sqlite
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.get('octo@example.com') as Record<string, unknown>
	expect(user).toBeTruthy()
	expect(user.username).toBe('octo-cat')
	if (typeof user.personal_org_id !== 'string') {
		throw new Error('OAuth signup did not store personal_org_id')
	}
	expect(user.personal_org_id).not.toBe(user.stable_user_id)
	expect(user.personal_org_id).toMatch(/^[a-f0-9]{64}$/)
	expect(
		sqlite
			.prepare(`SELECT id FROM orgs WHERE id = ?`)
			.get(user.personal_org_id),
	).toEqual({ id: user.personal_org_id })
	// Provider-verified email skips the verification-email flow.
	expect(user.email_verified_at).toBeTruthy()
	expect(
		countRows(
			sqlite,
			'user_roles',
			`JOIN roles ON roles.id = user_roles.role_id WHERE user_roles.user_id = ${user.id} AND roles.name = 'user'`,
		),
	).toBe(1)
	const connection = sqlite
		.prepare(
			`SELECT * FROM oauth_connections WHERE provider_name = 'github' AND provider_id = '99001'`,
		)
		.get() as Record<string, unknown>
	expect(connection.user_id).toBe(user.id)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_signup',
			result: 'success',
			reason: 'provider=github',
		}),
	)
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith({
		env: expect.anything(),
		source: 'oauth',
		user: {
			id: user.stable_user_id,
			username: 'octo-cat',
			email: 'octo@example.com',
		},
		attribution: null,
	})

	// A second sign-in with the same provider identity reuses the account.
	const { response: secondCallback } = await completeProviderFlow(env, 'github')
	expect(secondCallback.status).toBe(302)
	expect(new Headers(secondCallback.headers).get('Location')).toBe('/account')
	expect(setsCookie(secondCallback, 'kody_session=')).toBe(true)
	expect(countRows(sqlite, 'users')).toBe(1)
	// The first callback signs the user up and logs them in; the second
	// callback is a pure login. Nothing else is audited.
	expect(auditEventSummaries()).toEqual([
		'oauth_signup:success',
		'oauth_login:success',
		'oauth_login:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'success',
			reason: 'provider=github',
		}),
	)
})

test('github sign-in to MCP authorize strips prompt=login on return', async () => {
	const { db } = createMigratedDb()
	const env = createAppEnv(db)

	msw.use(
		http.post('https://github.com/login/oauth/access_token', () =>
			HttpResponse.json({ access_token: 'github-access-token' }),
		),
		http.get('https://api.github.com/user', () =>
			HttpResponse.json({
				id: 99002,
				login: 'authorize-octo',
				name: 'Authorize Octo',
				email: 'authorize-octo@example.com',
			}),
		),
		http.get('https://api.github.com/user/emails', () =>
			HttpResponse.json([
				{
					email: 'authorize-octo@example.com',
					primary: true,
					verified: true,
				},
			]),
		),
	)

	const authorizeResume =
		'/oauth/authorize?client_id=c&prompt=login&state=s&code_challenge=x&code_challenge_method=S256'
	const { response } = await completeProviderFlow(env, 'github', {
		startUrl: `http://example.com/auth/github?redirectTo=${encodeURIComponent(authorizeResume)}`,
	})
	expect(response.status).toBe(302)
	expect(new Headers(response.headers).get('Location')).toBe(
		'/oauth/authorize?client_id=c&state=s&code_challenge=x&code_challenge_method=S256&accountCreated=1',
	)
	expect(setsCookie(response, 'kody_session=')).toBe(true)
})

test('google sign-in links a matching verified email to the existing account', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)
	await seedUser(sqlite, {
		id: 7,
		email: 'existing@example.com',
		username: 'existing-user',
		emailVerified: true,
	})
	seedSecondFactors(sqlite, 7, 'keep')
	mockGoogleUserinfo({
		sub: 'google-sub-123',
		email: 'existing@example.com',
		name: 'Existing User',
	})

	const { start, response: callbackResponse } = await completeProviderFlow(
		env,
		'google',
	)
	expect(start.location).toContain(
		'https://accounts.google.com/o/oauth2/v2/auth',
	)
	expect(start.location).toContain('code_challenge_method=S256')
	expect(callbackResponse.status).toBe(302)
	expect(new Headers(callbackResponse.headers).get('Location')).toBe('/verify')
	expect(setsCookie(callbackResponse, 'kody_verify=')).toBe(true)

	const connection = sqlite
		.prepare(
			`SELECT * FROM oauth_connections WHERE provider_name = 'google' AND provider_id = 'google-sub-123'`,
		)
		.get() as Record<string, unknown>
	expect(connection.user_id).toBe(7)
	// The provider verified the exact account email, so the account is
	// treated as email-verified and keeps its password and second factors.
	const user = sqlite
		.prepare(`SELECT password_hash, email_verified_at FROM users WHERE id = 7`)
		.get() as { password_hash: string; email_verified_at: string | null }
	expect(user.email_verified_at).toBeTruthy()
	expect(await verifyPassword('test-password', user.password_hash)).toBe(true)
	expect([
		countRows(sqlite, 'verifications', `WHERE target = '7'`),
		countRows(sqlite, 'passkeys', 'WHERE user_id = 7'),
		countRows(sqlite, 'oauth_connections', 'WHERE user_id = 7'),
		countRows(sqlite, 'users'),
	]).toEqual([1, 1, 2, 1])
	expect(auditEventSummaries()).not.toContain(
		'social_link_reclaimed_unverified_account:success',
	)
})

test('google sign-in reclaims an unverified password account matching the provider email', async () => {
	const { sqlite, db } = createMigratedDb()
	const revokedGrantIds = new Array<string>()
	const env = createAppEnv(db, {
		OAUTH_PROVIDER: {
			listUserGrants: async () => ({
				items: revokedGrantIds.includes('grant-1')
					? []
					: [{ id: 'grant-1', clientId: 'client-a' }],
			}),
			revokeGrant: async (grantId: string) => {
				revokedGrantIds.push(grantId)
			},
		},
	})
	await seedUser(sqlite, {
		id: 8,
		email: 'squat@example.com',
		username: 'squatter',
		emailVerified: false,
	})
	seedSecondFactors(sqlite, 8, 'attacker')
	sqlite.exec(`
		INSERT INTO password_resets (user_id, token_hash, expires_at)
		VALUES (8, 'pending-reset', ${Date.now() + 60_000});
	`)
	mockGoogleUserinfo({
		sub: 'google-victim-sub',
		email: 'squat@example.com',
		name: 'Real Owner',
	})

	const { response: callbackResponse } = await completeProviderFlow(
		env,
		'google',
	)
	expect(callbackResponse.status).toBe(302)
	expect(new Headers(callbackResponse.headers).get('Location')).toBe('/account')
	expect(setsCookie(callbackResponse, 'kody_session=')).toBe(true)

	const user = sqlite
		.prepare(`SELECT password_hash, email_verified_at FROM users WHERE id = 8`)
		.get() as { password_hash: string; email_verified_at: string | null }
	expect(user.email_verified_at).toBeTruthy()
	expect(user.password_hash).toBe(unusablePasswordHash.reclaimedUnverified)
	expect(await verifyPassword('test-password', user.password_hash)).toBe(false)
	expect([
		countRows(sqlite, 'verifications', `WHERE target = '8'`),
		countRows(sqlite, 'passkeys', 'WHERE user_id = 8'),
		countRows(sqlite, 'password_resets'),
	]).toEqual([0, 0, 0])
	const connections = sqlite
		.prepare(
			`SELECT provider_name, provider_id FROM oauth_connections WHERE user_id = 8`,
		)
		.all() as Array<{ provider_name: string; provider_id: string }>
	expect(connections).toEqual([
		{ provider_name: 'google', provider_id: 'google-victim-sub' },
	])
	expect(revokedGrantIds).toEqual(['grant-1'])
	expect(auditEventSummaries()).toEqual([
		'social_link_reclaimed_unverified_account:success',
		'oauth_login:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'social_link_reclaimed_unverified_account',
			result: 'success',
			reason: expect.stringContaining(
				'provider=google;two_factor=1;passkeys=1;oauth_connections=1',
			),
		}),
	)
})

test('discord sign-in creates a verified account and assigns the guild role', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		DISCORD_BOT_TOKEN: 'bot-token-test',
		DISCORD_GUILD_ID: '111111111111111111',
		DISCORD_MEMBER_ROLE_ID: '222222222222222222',
		DISCORD_STANDARD_ROLE_ID: '444444444444444444',
		DISCORD_PRO_ROLE_ID: '555555555555555555',
	})
	const rolePuts: Array<string> = []
	const roleDeletes: Array<string> = []
	const guildJoins: Array<{ authorization: string; accessToken: string }> = []
	const guildMemberUrl =
		'https://discord.com/api/v10/guilds/111111111111111111/members/333333333333333333'

	msw.use(
		http.post('https://discord.com/api/oauth2/token', async ({ request }) => {
			const body = new URLSearchParams(await request.text())
			expect(body.get('client_id')).toBe('discord-client-id-test')
			expect(body.get('client_secret')).toBe('discord-client-secret-test')
			expect(body.get('code')).toBe('discord-auth-code')
			expect(body.get('code_verifier')?.length).toBeGreaterThan(0)
			return HttpResponse.json({ access_token: 'discord-access-token' })
		}),
		http.get('https://discord.com/api/v10/users/@me', ({ request }) => {
			expect(new Headers(request.headers).get('Authorization')).toBe(
				'Bearer discord-access-token',
			)
			return HttpResponse.json({
				id: '333333333333333333',
				username: 'koala-fan',
				global_name: 'Kody Fan',
				email: 'koala-fan@example.com',
				verified: true,
			})
		}),
		http.put(guildMemberUrl, async ({ request }) => {
			const body = (await request.json()) as { access_token?: string }
			guildJoins.push({
				authorization: new Headers(request.headers).get('Authorization') ?? '',
				accessToken: body.access_token ?? '',
			})
			return new HttpResponse(null, { status: 201 })
		}),
		...(['put', 'delete'] as const).map((method) =>
			http[method](`${guildMemberUrl}/roles/:roleId`, ({ request, params }) => {
				expect(new Headers(request.headers).get('Authorization')).toBe(
					'Bot bot-token-test',
				)
				;(method === 'put' ? rolePuts : roleDeletes).push(String(params.roleId))
				return new HttpResponse(null, { status: 204 })
			}),
		),
	)

	const { start, response: callbackResponse } = await completeProviderFlow(
		env,
		'discord',
	)
	expect(start.location).toContain('https://discord.com/oauth2/authorize')
	expect(start.location).toContain('code_challenge_method=S256')
	expect(start.location).toContain('scope=identify+email+guilds.join')
	expect(callbackResponse.status).toBe(302)
	expect(new Headers(callbackResponse.headers).get('Location')).toBe(
		'/onboarding?accountCreated=1',
	)
	const user = sqlite
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.get('koala-fan@example.com') as {
		id: number
		username: string
		email_verified_at: string | null
	}
	expect(user).toBeTruthy()
	expect(user.username).toBe('koala-fan')
	expect(user.email_verified_at).toBeTruthy()
	const connection = sqlite
		.prepare(
			`SELECT * FROM oauth_connections WHERE provider_name = 'discord' AND provider_id = '333333333333333333'`,
		)
		.get() as Record<string, unknown>
	expect(connection.user_id).toBe(user.id)
	expect(guildJoins).toEqual([
		{
			authorization: 'Bot bot-token-test',
			accessToken: 'discord-access-token',
		},
	])
	expect(rolePuts).toEqual(['222222222222222222'])
	expect(roleDeletes.sort()).toEqual([
		'444444444444444444',
		'555555555555555555',
	])

	const sessionCookiePair = sessionCookieFrom(callbackResponse)
	const connectionsHandler = testAccountConnectionsApiHandler(env)
	const syncResponse = await runConnectionsOperation(
		connectionsHandler,
		connectionsRequest(sessionCookiePair, { intent: 'sync-discord-role' }),
	)
	const syncPayload = syncResponse.data as {
		ok: boolean
		discordMemberRole?: { status: string }
	}
	expect(syncPayload.ok).toBe(true)
	expect(syncPayload.discordMemberRole?.status).toBe('assigned')
	expect(rolePuts).toEqual(['222222222222222222', '222222222222222222'])
	expect(roleDeletes).toHaveLength(4)

	const passwordHash = await createPasswordHash('test-password')
	sqlite
		.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`)
		.run(passwordHash, user.id)
	const disconnectResponse = await runConnectionsOperation(
		connectionsHandler,
		connectionsRequest(sessionCookiePair, {
			intent: 'disconnect',
			provider: 'discord',
		}),
	)
	const disconnectPayload = disconnectResponse.data as {
		ok: boolean
	}
	expect(disconnectPayload.ok).toBe(true)
	expect(disconnectPayload).toEqual({ ok: true })
	expect(countRows(sqlite, 'oauth_connections')).toBe(0)
	expect(roleDeletes).toHaveLength(7)
	expect(
		roleDeletes.filter((roleId) => roleId === '222222222222222222'),
	).toEqual(['222222222222222222'])
})

test('discord and x sign-ins without a verified email fail with a helpful error', async () => {
	const cases: Array<[Provider, () => void]> = [
		[
			'discord',
			() =>
				msw.use(
					http.post('https://discord.com/api/oauth2/token', () =>
						HttpResponse.json({ access_token: 'discord-access-token' }),
					),
					http.get('https://discord.com/api/v10/users/@me', () =>
						HttpResponse.json({
							id: '444444444444444444',
							username: 'unverified-discord',
							email: 'unverified-discord@example.com',
							verified: false,
						}),
					),
				),
		],
		[
			'x',
			() =>
				msw.use(
					http.post('https://api.x.com/2/oauth2/token', ({ request }) => {
						// X wants confidential-client credentials via HTTP Basic.
						expect(new Headers(request.headers).get('Authorization')).toBe(
							`Basic ${btoa('x-client-id-test:x-client-secret-test')}`,
						)
						return HttpResponse.json({ access_token: 'x-access-token' })
					}),
					http.get('https://api.x.com/2/users/me', () =>
						HttpResponse.json({
							data: { id: 'x-user-9', name: 'X User', username: 'xuser' },
						}),
					),
				),
		],
	]
	for (const [provider, mockProvider] of cases) {
		const { sqlite, db } = createMigratedDb()
		mockProvider()
		const { response } = await completeProviderFlow(createAppEnv(db), provider)
		expect(response.status).toBe(302)
		expect([provider, new Headers(response.headers).get('Location')]).toEqual([
			provider,
			'/login?oauthError=no-verified-email',
		])
		expect(countRows(sqlite, 'users')).toBe(0)
	}
})

test('signed-in discord connect returns to redirectTo instead of /account', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)
	await seedUser(sqlite, {
		id: 21,
		email: 'discord-page@example.com',
		username: 'discord-page',
		emailVerified: true,
	})
	const cookie = await sessionCookieFor('discord-page@example.com')

	msw.use(
		http.post('https://discord.com/api/oauth2/token', () =>
			HttpResponse.json({ access_token: 'discord-access-token' }),
		),
		http.get('https://discord.com/api/v10/users/@me', () =>
			HttpResponse.json({
				id: '666666666666666666',
				username: 'discord-page',
				global_name: 'Discord Page',
				email: 'discord-page@example.com',
				verified: true,
			}),
		),
	)
	const startUrl = 'http://example.com/auth/discord?redirectTo=%2Fdiscord'

	const { response: deniedResponse } = await completeProviderFlow(
		env,
		'discord',
		{ startUrl, cookie, query: 'error=access_denied' },
	)
	expect(new Headers(deniedResponse.headers).get('Location')).toBe(
		'/discord?oauthError=denied',
	)

	const { response: linkResponse } = await completeProviderFlow(
		env,
		'discord',
		{ startUrl, cookie },
	)
	expect(linkResponse.status).toBe(302)
	expect(new Headers(linkResponse.headers).get('Location')).toBe(
		'/discord?oauthLinked=discord',
	)
	const connection = sqlite
		.prepare(
			`SELECT user_id FROM oauth_connections WHERE provider_name = 'discord'`,
		)
		.get() as { user_id: number }
	expect(connection.user_id).toBe(21)

	const { response: relinkResponse } = await completeProviderFlow(
		env,
		'discord',
		{ startUrl, cookie },
	)
	expect(new Headers(relinkResponse.headers).get('Location')).toBe(
		'/discord?oauthLinked=discord',
	)
})

test('callback rejects a state mismatch', async () => {
	const { db } = createMigratedDb()
	const env = createAppEnv(db)

	const start = await startProviderFlow(
		env,
		'github',
		'http://example.com/auth/github?redirectTo=%2Fcommunity',
	)
	const callbackResponse = await runHandler(
		createAuthProviderCallbackHandler(env),
		new Request(
			`http://example.com/auth/github/callback?code=github-auth-code&state=not-the-state`,
			{ headers: { Cookie: start.stateCookie } },
		),
		{ provider: 'github' },
	)
	expect(callbackResponse.status).toBe(302)
	// The deep-link target survives the failure so a retry from the login
	// page still lands where the user was headed.
	expect(new Headers(callbackResponse.headers).get('Location')).toBe(
		'/login?oauthError=state-mismatch&redirectTo=%2Fcommunity',
	)
})

test('native OAuth start returns authorization URLs for signed-out and signed-in users', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)
	const jsonStart = (provider: string, init: RequestInit = {}) => {
		const request = new Request(
			`http://example.com/auth/${provider}${provider === 'github' ? '?redirectTo=%2Fcommunity' : ''}`,
			{
				method: 'POST',
				...init,
				headers: { Accept: 'application/json', ...init.headers },
			},
		)
		return {
			request,
			response: startWebsiteOAuth({
				env,
				provider,
				request,
				url: new URL(request.url),
				body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
			}),
		}
	}

	// The first-party UI calls the server function and
	// navigates itself because the CSP blocks form-POST and fetch-followed
	// redirects to the provider origin.
	const response = await jsonStart('github').response
	expect(response.status).toBe(200)
	const payload = response.data as {
		ok: boolean
		authorizeUrl: string
	}
	expect(payload.ok).toBe(true)
	expect(payload.authorizeUrl).toContain(
		'https://github.com/login/oauth/authorize',
	)
	expect(new Headers(response.headers).get('Set-Cookie')).toContain(
		'kody_oauth_login=',
	)

	const unknownProviderResponse = await jsonStart('nope').response
	expect(unknownProviderResponse.status).toBe(400)
	expect(unknownProviderResponse.data).toEqual({
		ok: false,
		code: 'unknown-provider',
		error: 'That sign-in provider is not supported.',
	})

	// Signed-in connection flows use the same operation and authorization state cookie.
	await seedUser(sqlite, {
		id: 21,
		email: 'connector@example.com',
		username: 'connector',
	})
	const signedInCookie = await sessionCookieFor('connector@example.com')
	for (const [provider, cookie] of [
		['github', null],
		['google', signedInCookie],
	] as const) {
		const started = jsonStart(provider, {
			headers: {
				'Content-Type': 'application/json',
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: JSON.stringify(emptyPublicFormProtection()),
		})
		expect((await started.response).status).toBe(200)
	}
})

test('signed-in users link and disconnect providers from their account', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	})
	await seedUser(sqlite, {
		id: 11,
		email: 'linker@example.com',
		username: 'linker',
		emailVerified: true,
	})
	const cookie = await sessionCookieFor('linker@example.com')

	// Linking: signed-in start + callback attaches the identity to the
	// current account instead of creating or switching accounts.
	const { response: linkResponse } = await completeProviderFlow(env, 'github', {
		cookie,
		mockMode: true,
	})
	expect(linkResponse.status).toBe(302)
	expect(new Headers(linkResponse.headers).get('Location')).toBe(
		'/account/security?oauthLinked=github',
	)
	const connection = sqlite
		.prepare(
			`SELECT user_id FROM oauth_connections WHERE provider_name = 'github'`,
		)
		.get() as { user_id: number }
	expect(connection.user_id).toBe(11)

	// Re-linking the same identity is a no-op success.
	const { response: relinkResponse } = await completeProviderFlow(
		env,
		'github',
		{ cookie, mockMode: true },
	)
	expect(new Headers(relinkResponse.headers).get('Location')).toBe(
		'/account/security?oauthLinked=github',
	)

	// The same provider identity linked to a different signed-in user is a
	// conflict surfaced on the Security page, never an account switch.
	await seedUser(sqlite, {
		id: 12,
		email: 'other@example.com',
		username: 'other-user',
		emailVerified: true,
	})
	const { response: conflictResponse } = await completeProviderFlow(
		env,
		'github',
		{ cookie: await sessionCookieFor('other@example.com'), mockMode: true },
	)
	expect(new Headers(conflictResponse.headers).get('Location')).toBe(
		'/account/security?oauthError=connection-conflict',
	)

	// The connections API lists the link; disconnecting the only connection
	// is allowed here because the seeded user has a usable password.
	const connectionsHandler = testAccountConnectionsApiHandler(env)
	const listResponse = await runConnectionsOperation(
		connectionsHandler,
		connectionsRequest(cookie),
	)
	const listPayload = listResponse.data as {
		ok: boolean
		connections: Array<{ provider: string; displayName: string | null }>
		canDisconnect: boolean
		availableProviders: Array<{ id: string }>
	}
	expect(listPayload.ok).toBe(true)
	expect(listPayload.connections).toHaveLength(1)
	expect(listPayload.connections[0]?.provider).toBe('github')
	expect(listPayload.canDisconnect).toBe(true)
	expect(listPayload.availableProviders.map((p) => p.id)).toEqual([
		'google',
		'x',
		'discord',
	])

	const disconnectResponse = await runConnectionsOperation(
		connectionsHandler,
		connectionsRequest(cookie, { intent: 'disconnect', provider: 'github' }),
	)
	const disconnectPayload = disconnectResponse.data as {
		ok: boolean
	}
	expect(disconnectPayload.ok).toBe(true)
	expect(disconnectPayload).toEqual({ ok: true })
	expect(countRows(sqlite, 'oauth_connections')).toBe(0)
})

test('MOCK_ client ids run the whole flow in-worker and refuse disconnecting the only sign-in method', async () => {
	const { sqlite, db } = createMigratedDb()
	// onUnhandledFrame: 'error' in the shared MSW server means any real
	// provider call would fail this test.
	const env = createAppEnv(db, {
		GITHUB_CLIENT_ID: 'MOCK_GITHUB_CLIENT_ID',
		GITHUB_CLIENT_SECRET: 'MOCK_GITHUB_CLIENT_SECRET',
	})

	const { start, response: callbackResponse } = await completeProviderFlow(
		env,
		'github',
		{ mockMode: true },
	)
	// Mock mode redirects straight back to the callback with a mock code.
	const callbackUrl = new URL(start.location)
	expect(callbackUrl.pathname).toBe('/auth/github/callback')
	expect(callbackUrl.searchParams.get('state')).toBe(start.state)
	expect(callbackResponse.status).toBe(302)
	// A brand-new social account lands on onboarding, the same place password
	// signups reach after verification.
	expect(new Headers(callbackResponse.headers).get('Location')).toBe(
		'/onboarding?accountCreated=1',
	)
	const user = sqlite
		.prepare(`SELECT * FROM users WHERE email = ?`)
		.get('mock-github-user@example.com') as Record<string, unknown>
	expect(user).toBeTruthy()
	expect(user.username).toBe('mock-octo')

	// The social signup has no usable password, so its single connection
	// must not be removable.
	const cookie = sessionCookieFrom(callbackResponse)
	const connectionsHandler = testAccountConnectionsApiHandler(env)
	const listResponse = await runConnectionsOperation(
		connectionsHandler,
		connectionsRequest(cookie),
	)
	expect(listResponse.data).toMatchObject({ canDisconnect: false })

	const disconnectResponse = await runConnectionsOperation(
		connectionsHandler,
		connectionsRequest(cookie, { intent: 'disconnect', provider: 'github' }),
	)
	expect(disconnectResponse.status).toBe(400)
	expect(countRows(sqlite, 'oauth_connections')).toBe(1)
})

test('OAuth signup persists first-touch UTMs from the start URL through login state', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db)
	mockGithubProfileExchange('utm-oauth@example.com')

	const { response: callbackResponse } = await completeProviderFlow(
		env,
		'github',
		{
			startUrl:
				'http://example.com/auth/github?utm_source=youtube&utm_medium=video&utm_campaign=bwk-2026-08-27&landing_path=%2Fsignup',
		},
	)
	expect(callbackResponse.status).toBe(302)
	expect(new Headers(callbackResponse.headers).get('Location')).toBe(
		'/onboarding?accountCreated=1',
	)
	const user = sqlite
		.prepare(
			`SELECT utm_source, utm_medium, utm_campaign, first_touch_landing_path
			 FROM users WHERE email = ?`,
		)
		.get('utm-oauth@example.com') as Record<string, unknown>
	expect(user).toEqual({
		utm_source: 'youtube',
		utm_medium: 'video',
		utm_campaign: 'bwk-2026-08-27',
		first_touch_landing_path: '/signup',
	})
	expect(lifecycleMocks.scheduleUserCreatedEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			attribution: expect.objectContaining({
				utmSource: 'youtube',
				utmMedium: 'video',
				utmCampaign: 'bwk-2026-08-27',
				landingPath: '/signup',
			}),
		}),
	)
})

test('OAuth signup returns a controlled error when another account claims the email', async () => {
	const { sqlite, db } = createMigratedDb()
	const claimedEmail = 'former-oauth@example.com'
	await seedUser(sqlite, {
		id: 1,
		email: 'current-oauth@example.com',
		username: 'current-oauth',
	})
	sqlite.exec(`
		INSERT INTO user_email_claims (user_id, email, status, claimed_at, updated_at)
		VALUES (1, ${quoteSqlString(claimedEmail)}, 'claimed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
	`)
	mockGithubProfileExchange(claimedEmail)

	const { response: callback } = await completeProviderFlow(
		createAppEnv(db),
		'github',
	)
	expect(callback.status).toBe(302)
	expect(new Headers(callback.headers).get('Location')).toBe(
		'/login?oauthError=email-claimed',
	)
	expect(countRows(sqlite, 'users')).toBe(1)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'oauth_login',
			result: 'failure',
			reason: 'former_email_claimed',
		}),
	)
})

test('github signup skips a KV-reserved provider handle', async () => {
	const { sqlite, db } = createMigratedDb()
	const env = createAppEnv(db, {
		BUNDLE_ARTIFACTS_KV: createMemoryKv({
			[reservedUsernamesKvKey]: JSON.stringify({
				added: ['octo-cat'],
				removed: [],
				updatedAt: '2026-09-02T00:00:00.000Z',
				updatedBy: 'admin-stable-id',
			}),
		}),
	})
	mockGithubProfileExchange('octo-reserved@example.com', 99002)

	const { response: callbackResponse } = await completeProviderFlow(
		env,
		'github',
	)
	expect(callbackResponse.status).toBe(302)
	const user = sqlite
		.prepare(`SELECT username FROM users WHERE email = ?`)
		.get('octo-reserved@example.com') as { username: string }
	expect(user.username).not.toBe('octo-cat')
	expect(user.username.includes('octocat')).toBe(false)
	expect(getUsernameValidationError(user.username)).toBeNull()
})

async function runConnectionsOperation(
	operation: ReturnType<typeof testAccountConnectionsApiHandler>,
	request: Request,
) {
	return operation.execute({ request })
}
