import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	handlePackageAppOauthHostAuth,
	isPackageAppOauthHostAuthPath,
} from '#app/package-app-oauth-host-auth.ts'
import { handlePackageAppOauthAuthorizeRequest } from '#app/package-app-oauth-authorize.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { createS256CodeChallenge } from '#app/package-app-oauth-pkce-cookie.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

vi.mock(
	'#worker/package-invocations/module-artifacts.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/package-invocations/module-artifacts.ts')
			>()
		return {
			...actual,
			loadInvokeManifestBySourceId: async () => ({
				manifest: { kody: { app: { visitorNeeds: {} } } },
			}),
		}
	},
)

vi.mock(
	'#worker/credentials/credential-needs-closure.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/credentials/credential-needs-closure.ts')
			>()
		return {
			...actual,
			loadPublishedCredentialNeeds: async () => [
				{
					key: 'calendar',
					kind: 'secret',
					provider: 'calendar',
					description: 'Calendar access.',
					multiple: false,
					supplier: 'executor',
					required: true,
				},
			],
		}
	},
)

vi.mock(
	'#worker/credentials/credential-candidates.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/credentials/credential-candidates.ts')
			>()
		return {
			...actual,
			listUsableCredentials: async () => [],
		}
	},
)

const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.isolated.test'
const ownerEmail = 'pkg-oauth-owner@example.com'
const ownerUsername = 'pkgoauth'

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = packageAppOrigin
	// The shared protocol test uses the test bindings, not the SSR build entry.
	mutableEnv.SENTRY_ENVIRONMENT = 'test'
}

async function workerFetch(url: string | URL, init: RequestInit = {}) {
	const request = new Request(url, { redirect: 'manual', ...init })
	if (isPackageAppOauthHostAuthPath(new URL(request.url).pathname)) {
		const response = await handlePackageAppOauthHostAuth({
			request,
			env,
			url: new URL(request.url),
		})
		if (!response)
			throw new Error('Expected package app host protocol response')
		return response
	}
	return handlePackageAppOauthAuthorizeRequest(request, env, {
		allowConsentSkip: false,
	})
}

async function ensureOauthGrantSchema() {
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_oauth_grants (
			id TEXT PRIMARY KEY NOT NULL,
			person_id TEXT NOT NULL,
			org_username TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			scopes TEXT NOT NULL,
			created_at TEXT NOT NULL,
			revoked_at TEXT,
			last_used_at TEXT
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_oauth_codes (
			code_hash TEXT PRIMARY KEY NOT NULL,
			payload TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_grant_credential_mappings (
			grant_id TEXT NOT NULL,
			need_key TEXT NOT NULL,
			credential_ids_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (grant_id, need_key)
		)`,
	).run()
}

async function seedOwnerPackageApp(slug = 'demo') {
	const ownerId = testStableUserIdFromEmail(ownerEmail)
	const now = '2026-10-16T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, is_internet_visible,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, '', '[]', NULL, ?, 1, 0, 1, 0, ?, ?)`,
	)
		.bind(
			`pkg-oauth-${ownerUsername}-${slug}`,
			ownerId,
			`@${ownerUsername}/${slug}`,
			slug,
			`src-oauth-${ownerUsername}-${slug}`,
			now,
			now,
		)
		.run()
}

async function seedOwnerSessionCookie() {
	await ensureAuditEventsTestSchema(env.AUDIT_DB)
	await ensureRbacTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensureOauthGrantSchema()
	await ensureUsersTestSchema({
		db: env.APP_DB,
	})
	for (const statement of [
		`CREATE TABLE IF NOT EXISTS permissions (
			id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
			action TEXT NOT NULL,
			entity TEXT NOT NULL,
			access TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS role_permissions (
			role_id INTEGER NOT NULL,
			permission_id INTEGER NOT NULL,
			PRIMARY KEY (role_id, permission_id)
		)`,
	]) {
		await env.APP_DB.prepare(statement).run()
	}
	await seedAccount({
		db: env.APP_DB,
		email: ownerEmail,
		username: ownerUsername,
	})
	await seedOwnerPackageApp('demo')
	setAuthSessionSecret(env.COOKIE_SECRET)
	const setCookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail(ownerEmail),
			email: ownerEmail,
			rememberMe: false,
		},
		true,
	)
	return setCookie.split(';')[0] ?? ''
}

async function loadRequiredExecutorConsent(slug: string) {
	configureOrigins()
	const cookie = await seedOwnerSessionCookie()
	await seedOwnerPackageApp(slug)
	const challenge = await createS256CodeChallenge(
		'oauth-workers-test-verifier-32chars!!',
	)
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/${slug}`)
	url.searchParams.set(
		'redirect_uri',
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`,
	)
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'need:calendar')
	const result = await workerFetch(url, { headers: { Cookie: cookie } })
	if (result instanceof Response)
		throw new Error('Expected executor consent data')
	return { consent: result.consent, cookie, url }
}

test('package-app OAuth authorize refuses unallowlisted redirect_uri', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	const verifier = 'oauth-workers-test-verifier-32chars!!'
	const challenge = await createS256CodeChallenge(verifier)
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/demo`)
	url.searchParams.set(
		'redirect_uri',
		'https://evil.example/_kody/auth/callback',
	)
	url.searchParams.set('state', 'state-1')
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'profile')

	const response = await workerFetch(url, {
		headers: { Cookie: sessionCookie },
	})
	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected redirect refusal')
	expect(response.status).toBe(400)
	await expect(response.text()).resolves.toMatch(/redirect_uri/)
})

test('package-app OAuth authorize returns authenticated consent claims without issuing a code', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	const verifier = 'oauth-workers-test-verifier-32chars!!'
	const challenge = await createS256CodeChallenge(verifier)
	const redirectUri = `https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/demo`)
	url.searchParams.set('redirect_uri', redirectUri)
	url.searchParams.set('state', 'state-2')
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'email')

	const response = await workerFetch(url, {
		headers: { Cookie: sessionCookie },
	})
	expect(response).not.toBeInstanceOf(Response)
	if (response instanceof Response)
		throw new Error('Expected authenticated consent data')
	expect(response.consent).toMatchObject({
		ok: true,
		clientId: `${ownerUsername}/demo`,
		redirectUri,
		publisherUsername: ownerUsername,
		claimLabels: expect.arrayContaining(['See your email address']),
		hiddenFields: {
			state: 'state-2',
			code_challenge: challenge,
			code_challenge_method: 'S256',
			redirect_uri: redirectUri,
			scope: 'profile email',
		},
	})
	expect(response.consent.optionalScopes).toEqual([
		{ scope: 'email', label: 'See your email address' },
	])
})

test('package-app consent does not repeat required scopes in already allowed claims', async () => {
	configureOrigins()
	const cookie = await seedOwnerSessionCookie()
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO package_app_oauth_grants (
			id, person_id, org_username, kody_id, scopes, created_at, revoked_at, last_used_at
		) VALUES (?, ?, ?, ?, 'profile', ?, NULL, NULL)`,
	)
		.bind(
			'profile-only-grant',
			testStableUserIdFromEmail(ownerEmail),
			ownerUsername,
			'demo',
			'2026-10-16T00:00:00.000Z',
		)
		.run()
	const challenge = await createS256CodeChallenge(
		'oauth-workers-test-verifier-32chars!!',
	)
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	url.searchParams.set('client_id', `${ownerUsername}/demo`)
	url.searchParams.set(
		'redirect_uri',
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`,
	)
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'email')

	const response = await workerFetch(url, {
		headers: { Cookie: cookie },
	})
	if (response instanceof Response) throw new Error('Expected consent data')
	expect(response.consent.alreadyAllowedScopes).toEqual([])
	expect(response.consent.alreadyAllowedLabels).toEqual([])
	await env.APP_DB.prepare('DELETE FROM package_app_oauth_grants WHERE id = ?')
		.bind('profile-only-grant')
		.run()
})

test('package-app consent rejects chosen scopes that were not requested', async () => {
	configureOrigins()
	const cookie = await seedOwnerSessionCookie()
	const challenge = await createS256CodeChallenge(
		'oauth-workers-test-verifier-32chars!!',
	)
	const authorizeUrl = new URL(packageAppOauthPaths.authorize, appOrigin)
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', `${ownerUsername}/demo`)
	authorizeUrl.searchParams.set(
		'redirect_uri',
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`,
	)
	authorizeUrl.searchParams.set('code_challenge', challenge)
	authorizeUrl.searchParams.set('code_challenge_method', 'S256')
	authorizeUrl.searchParams.set('scope', 'profile')
	const consent = await workerFetch(authorizeUrl, {
		headers: { Cookie: cookie },
	})
	if (consent instanceof Response) throw new Error('Expected consent data')
	const form = new URLSearchParams({
		...consent.consent.hiddenFields,
		selected_scopes: 'profile email',
		decision: 'approve',
	})
	const response = await workerFetch(authorizeUrl, {
		method: 'POST',
		headers: {
			Cookie: cookie,
			Origin: appOrigin,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: form,
	})
	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected rejected scope')
	expect(response.status).toBe(403)
})

test('package-app consent rejects a forged credential id on approval', async () => {
	const scenario = await loadRequiredExecutorConsent('forged-credential')
	const form = new URLSearchParams()
	for (const [name, value] of Object.entries(scenario.consent.hiddenFields))
		form.append(name, value)
	form.append('selected_scopes', 'profile')
	form.append('selected_scopes', 'need:calendar')
	form.set('credential_need:calendar', 'forged-credential-id')
	form.set('decision', 'approve')
	const response = await workerFetch(scenario.url, {
		method: 'POST',
		headers: {
			Cookie: scenario.cookie,
			Origin: appOrigin,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: form,
	})

	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected forged credential refusal')
	expect(response.status).toBe(400)
	await expect(response.text()).resolves.toContain(
		'The selected credential for calendar is no longer available',
	)
})

test('package-app consent keeps a required executor scope selected on approval', async () => {
	const scenario = await loadRequiredExecutorConsent('required-credential')
	const form = new URLSearchParams()
	for (const [name, value] of Object.entries(scenario.consent.hiddenFields))
		form.append(name, value)
	form.append('selected_scopes', 'profile')
	form.set('decision', 'approve')
	const response = await workerFetch(scenario.url, {
		method: 'POST',
		headers: {
			Cookie: scenario.cookie,
			Origin: appOrigin,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: form,
	})

	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected required credential selection response')
	expect(response.status).toBe(400)
	await expect(response.text()).resolves.toContain(
		'Choose a credential for the calendar need',
	)
})

test('package-app consent form submits rendered fields and redirects with a code', async () => {
	configureOrigins()
	const cookie = await seedOwnerSessionCookie()
	const challenge = await createS256CodeChallenge(
		'oauth-workers-test-verifier-32chars!!',
	)
	const authorizeUrl = new URL(packageAppOauthPaths.authorize, appOrigin)
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', `${ownerUsername}/demo`)
	authorizeUrl.searchParams.set(
		'redirect_uri',
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`,
	)
	authorizeUrl.searchParams.set('state', 'rendered-form-state')
	authorizeUrl.searchParams.set('code_challenge', challenge)
	authorizeUrl.searchParams.set('code_challenge_method', 'S256')
	authorizeUrl.searchParams.set('scope', 'email')

	const consent = await workerFetch(authorizeUrl, {
		headers: { Cookie: cookie },
	})
	if (consent instanceof Response) throw new Error('Expected consent data')
	const form = new URLSearchParams()
	for (const [name, value] of Object.entries(consent.consent.hiddenFields))
		form.append(name, value)
	for (const { scope } of consent.consent.optionalScopes)
		form.append('selected_scopes', scope)
	for (const scope of consent.consent.requiredScopes)
		form.append('selected_scopes', scope)
	form.append('decision', 'approve')
	expect(form.get('scope')).toBe('profile email')
	expect(form.getAll('selected_scopes')).toEqual(['email', 'profile'])
	const response = await workerFetch(authorizeUrl, {
		method: 'POST',
		headers: {
			Cookie: cookie,
			Origin: appOrigin,
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: form,
	})
	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected app callback redirect')
	expect(response.status).toBe(302)
	const location = new URL(response.headers.get('Location') ?? '')
	expect(location.origin).toBe(
		`https://${ownerUsername}.packages.isolated.test`,
	)
	expect(location.pathname).toBe(packageAppOauthPaths.callback)
	expect(location.searchParams.get('code')).toBeTruthy()
	expect(location.searchParams.get('state')).toBe('rendered-form-state')
	await env.APP_DB.prepare(
		`DELETE FROM package_app_oauth_grants
		 WHERE person_id = ? AND org_username = ? AND kody_id = ?`,
	)
		.bind(testStableUserIdFromEmail(ownerEmail), ownerUsername, 'demo')
		.run()
})

test('package-app consent skip can be forced with prompt=consent', async () => {
	configureOrigins()
	const cookie = await seedOwnerSessionCookie()
	const challenge = await createS256CodeChallenge(
		'oauth-workers-test-verifier-32chars!!',
	)
	const authorizeUrl = new URL(packageAppOauthPaths.authorize, appOrigin)
	authorizeUrl.searchParams.set('response_type', 'code')
	authorizeUrl.searchParams.set('client_id', `${ownerUsername}/demo`)
	authorizeUrl.searchParams.set(
		'redirect_uri',
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`,
	)
	authorizeUrl.searchParams.set('code_challenge', challenge)
	authorizeUrl.searchParams.set('code_challenge_method', 'S256')
	authorizeUrl.searchParams.set('scope', 'profile')
	const response = await handlePackageAppOauthAuthorizeRequest(
		new Request(authorizeUrl, { headers: { Cookie: cookie } }),
		env,
	)
	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected executor consent skip redirect')
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toContain('code=')

	authorizeUrl.searchParams.set('prompt', 'consent')
	const result = await handlePackageAppOauthAuthorizeRequest(
		new Request(authorizeUrl, { headers: { Cookie: cookie } }),
		env,
	)

	expect(result).not.toBeInstanceOf(Response)
	expect(result).toHaveProperty('consent')
})

test('authenticated consent decisions reject a foreign origin before creating a grant', async () => {
	configureOrigins()
	const cookie = await seedOwnerSessionCookie()
	const challenge = await createS256CodeChallenge(
		'oauth-workers-test-verifier-32chars!!',
	)
	const response = await workerFetch(
		new URL(packageAppOauthPaths.authorize, appOrigin),
		{
			method: 'POST',
			headers: {
				Cookie: cookie,
				Origin: 'https://evil.example',
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				response_type: 'code',
				client_id: `${ownerUsername}/demo`,
				redirect_uri: `https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.callback}`,
				code_challenge: challenge,
				code_challenge_method: 'S256',
				scope: 'email',
				decision: 'approve',
			}),
		},
	)
	expect(response).toBeInstanceOf(Response)
	if (!(response instanceof Response))
		throw new Error('Expected origin refusal')
	expect(response.status).toBe(403)
	const row = await env.APP_DB.prepare(
		'SELECT COUNT(*) AS count FROM package_app_oauth_grants',
	).first<{ count: number }>()
	expect(row?.count).toBe(0)
})

test('package-app OAuth authorize rejects client_id that is not a published package app', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	const verifier = 'oauth-workers-test-verifier-32chars!!'
	const challenge = await createS256CodeChallenge(verifier)
	const url = new URL(packageAppOauthPaths.authorize, appOrigin)
	url.searchParams.set('response_type', 'code')
	// Bogus subdomain-shaped owner label — no such published package.
	url.searchParams.set('client_id', 'kentcdodds-world-builder/world-builder')
	url.searchParams.set(
		'redirect_uri',
		`https://kentcdodds-world-builder.packages.isolated.test${packageAppOauthPaths.callback}`,
	)
	url.searchParams.set('state', 'state-bogus')
	url.searchParams.set('code_challenge', challenge)
	url.searchParams.set('code_challenge_method', 'S256')
	url.searchParams.set('scope', 'profile')

	const response = await workerFetch(url, {
		headers: { Cookie: sessionCookie },
	})
	if (!(response instanceof Response))
		throw new Error('Expected OAuth protocol response')
	expect(response.status).toBe(400)
	await expect(response.text()).resolves.toMatch(
		/invalid_client|published package app/,
	)
})

test('package-app OAuth login on unverified subdomain label rejects without trusting the host as owner', async () => {
	configureOrigins()
	await seedOwnerSessionCookie()
	const loginUrl = new URL(
		`https://kentcdodds-world-builder.packages.isolated.test${packageAppOauthPaths.login}`,
	)
	loginUrl.searchParams.set('app', 'world-builder')
	const response = await workerFetch(loginUrl)
	if (!(response instanceof Response))
		throw new Error('Expected OAuth protocol response')
	expect(response.status).toBe(400)
	const body = await response.text()
	expect(body).toMatch(/Unknown or unpublished package app/)
	expect(response.headers.get('Location')).toBeNull()
})

test('package-app OAuth login on a real owner subdomain redirects to authorize with that client_id', async () => {
	configureOrigins()
	await seedOwnerSessionCookie()
	const loginUrl = new URL(
		`https://${ownerUsername}.packages.isolated.test${packageAppOauthPaths.login}`,
	)
	loginUrl.searchParams.set('app', 'demo')
	loginUrl.searchParams.set('scope', 'profile need:calendar')
	loginUrl.searchParams.set('prompt', 'consent')
	const response = await workerFetch(loginUrl)
	if (!(response instanceof Response))
		throw new Error('Expected OAuth protocol response')
	expect(response.status).toBe(302)
	const location = response.headers.get('Location')
	expect(location).toBeTruthy()
	const authorize = new URL(location!)
	expect(authorize.origin).toBe(appOrigin)
	expect(authorize.pathname).toBe('/oauth/package-app/authorize')
	expect(authorize.searchParams.get('client_id')).toBe(`${ownerUsername}/demo`)
	expect(authorize.searchParams.get('prompt')).toBe('consent')
})

test('local inline package-app OAuth keeps its request origin through consent', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	const mutableEnv = env as unknown as Record<string, string | undefined>
	const previousLocalDev = mutableEnv.WRANGLER_IS_LOCAL_DEV
	mutableEnv.WRANGLER_IS_LOCAL_DEV = 'true'

	try {
		const localOrigin = 'http://localhost:8788'
		const loginUrl = new URL(packageAppOauthPaths.login, localOrigin)
		loginUrl.searchParams.set('org', ownerUsername)
		loginUrl.searchParams.set('app', 'demo')
		loginUrl.searchParams.set('scope', 'email')
		loginUrl.searchParams.set('return_to', '/packages/demo')

		const login = await workerFetch(loginUrl)
		if (!(login instanceof Response))
			throw new Error('Expected OAuth login redirect')
		expect(login.status).toBe(302)
		const location = login.headers.get('Location')
		expect(location).toBeTruthy()
		const authorizeUrl = new URL(location!)
		expect(authorizeUrl.origin).toBe(localOrigin)
		expect(authorizeUrl.pathname).toBe(packageAppOauthPaths.authorize)

		const consent = await workerFetch(authorizeUrl, {
			headers: { Cookie: sessionCookie },
		})
		if (consent instanceof Response)
			throw new Error('Expected authenticated consent data')
		expect(consent.consent).toMatchObject({
			ok: true,
			clientId: `${ownerUsername}/demo`,
			redirectUri: `${localOrigin}${packageAppOauthPaths.callback}`,
		})
		expect(consent.consent.hiddenFields.scope).toBe('profile email')

		const denied = await workerFetch(authorizeUrl, {
			method: 'POST',
			headers: {
				Cookie: sessionCookie,
				Origin: localOrigin,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: new URLSearchParams({
				...consent.consent.hiddenFields,
				selected_scopes: 'profile',
				decision: 'deny',
			}),
		})
		if (!(denied instanceof Response))
			throw new Error('Expected consent decision redirect')
		expect(denied.status).toBe(302)
		const callback = new URL(denied.headers.get('Location')!)
		expect(callback.origin).toBe(localOrigin)
		expect(callback.pathname).toBe(packageAppOauthPaths.callback)
		expect(callback.searchParams.get('error')).toBe('access_denied')
	} finally {
		mutableEnv.WRANGLER_IS_LOCAL_DEV = previousLocalDev
	}
})
