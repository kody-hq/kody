import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createPackageCodeRequest,
	handlePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import {
	buildPackageAppNotFoundMessage,
	buildUnmatchedPackageAppOriginPathMessage,
} from '#worker/package-runtime/package-app-synthetic.ts'
import {
	consoleError,
	silenceExpectedConsoleErrors,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { createPackageAppSessionCookie } from '#app/package-app-session.ts'
import {
	accessFixture,
	accessFixtureOrigin,
	packageAppSessionCookieFor,
	seedPackageAppAccessFixture,
} from '#worker/test-support/package-app-access-fixture.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

// Different ports on purpose: swapping origins by mutating a `URL` keeps the
// original port, and identical ports would hide that.
const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.isolated.test'
const ownerEmail = 'pkg-owner@example.com'
const ownerUsername = 'pkg-owner'
// Hosted package apps are served from the owner's own subdomain of the
// package-app origin; the bare origin only redirects.
const ownerPackageAppOrigin = `https://${ownerUsername}.packages.isolated.test`

/**
 * The generated `Env` types pin production var literals, so origin overrides go
 * through a mutable view of the same object the worker handler receives.
 */
function configureOrigins(input: {
	packageAppBaseUrl?: string
	runtime: 'production' | 'preview'
}) {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = input.packageAppBaseUrl
	mutableEnv.SENTRY_ENVIRONMENT = input.runtime
}

async function workerFetch(
	url: string | URL,
	init: RequestInit = {},
): Promise<Response> {
	// `redirect: 'manual'` keeps the entrypoint stub from following the
	// cross-origin hops this suite is asserting on.
	return await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
	)
}

async function seedOwnerSessionCookie() {
	await ensureAuditEventsTestSchema(env.AUDIT_DB)
	await ensureRbacTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	// Session resolution joins the permission tables; without them every request
	// logs a role-lookup failure.
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN password_changed_at TEXT`,
		).run()
	} catch {
		// Column already present from an earlier seed in this suite.
	}
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

const teamOrgSlug = 'acme-apps'
const teamOwnerEmail = 'acme-boss@example.com'
const teamOwnerUsername = 'acme-boss'
const teamRunnerEmail = 'acme-runner@example.com'
const teamReaderEmail = 'acme-reader@example.com'
const teamGuestEmail = 'acme-guest@example.com'
const teamOrgId = testStableUserIdFromEmail('acme-apps-org@example.com')
const teamPackageAppOrigin = `https://${teamOrgSlug}.packages.isolated.test`

async function sessionCookieFor(email: string) {
	setAuthSessionSecret(env.COOKIE_SECRET)
	const setCookie = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail(email),
			email,
			rememberMe: false,
		},
		true,
	)
	return setCookie.split(';')[0] ?? ''
}

async function seedTeamOrgPackageAppFixture() {
	await ensureAuditEventsTestSchema(env.AUDIT_DB)
	await ensureRbacTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE users ADD COLUMN password_changed_at TEXT`,
		).run()
	} catch {
		// Column already present from an earlier seed in this suite.
	}
	for (const [email, username] of [
		[teamOwnerEmail, teamOwnerUsername],
		[teamRunnerEmail, 'acme-runner'],
		[teamReaderEmail, 'acme-reader'],
		[teamGuestEmail, 'acme-guest'],
	] as const) {
		await seedAccount({ db: env.APP_DB, email, username })
	}
	const now = '2026-10-14T00:00:00.000Z'
	const ownerId = testStableUserIdFromEmail(teamOwnerEmail)
	const runnerId = testStableUserIdFromEmail(teamRunnerEmail)
	const readerId = testStableUserIdFromEmail(teamReaderEmail)
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO orgs (id, slug, display_name, plan, created_at, updated_at)
		 VALUES (?, ?, 'Acme Apps', 'free', ?, ?)`,
	)
		.bind(teamOrgId, teamOrgSlug, now, now)
		.run()
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
	)
		.bind(teamOrgSlug, teamOrgId, now)
		.run()
	for (const [personId, role] of [
		[ownerId, 'owner'],
		[runnerId, 'member'],
		[readerId, 'member'],
	] as const) {
		await env.APP_DB.prepare(
			`INSERT OR IGNORE INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, ?, ?)`,
		)
			.bind(teamOrgId, personId, role, now)
			.run()
	}
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO grants (
			id, org_id, resource_type, resource_id, subject_type, subject_id,
			preset, created_by_user_id, created_at, updated_at
		) VALUES (?, ?, 'org', ?, 'user', ?, 'use', ?, ?, ?)`,
	)
		.bind(
			'grant-acme-apps-execute',
			teamOrgId,
			teamOrgId,
			runnerId,
			ownerId,
			now,
			now,
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO grant_permissions (grant_id, permission)
		 VALUES (?, 'app:execute')`,
	)
		.bind('grant-acme-apps-execute')
		.run()
}

async function outcome(response: Response) {
	return { status: response.status, body: await response.text() }
}

test('hosted package apps move to the owner subdomain behind a single-use handoff', async () => {
	silenceExpectedConsoleWarns(['Package app handoff rejected.'])
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const sessionCookie = await seedOwnerSessionCookie()
	const entryUrl = `${appOrigin}/@${ownerUsername}/packages/demo/open/report`
	const legacyEntryUrl = `${appOrigin}/@${ownerUsername}/packages/demo/report`

	// 1. The app origin never executes package code: /open mints a handoff token
	// and redirects to the owner's package-app subdomain, where the username
	// lives in the hostname and the path carries only the package mount. Query
	// preserved. Bare /packages/{name}/… still hands off for old links.
	const appOriginResponse = await workerFetch(`${entryUrl}?tab=1`, {
		headers: { Cookie: sessionCookie },
	})
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(ownerPackageAppOrigin)
	expect(handoffLocation.pathname).toBe('/demo/report')
	expect(handoffLocation.searchParams.get('tab')).toBe('1')
	const handoffToken = handoffLocation.searchParams.get(
		packageAppHandoffQueryParam,
	)
	expect(handoffToken).toBeTruthy()
	const bareMountHandoff = await workerFetch(`${legacyEntryUrl}?tab=1`, {
		headers: { Cookie: sessionCookie },
	})
	expect(bareMountHandoff.status).toBe(302)
	expect(new URL(bareMountHandoff.headers.get('Location') ?? '').pathname).toBe(
		'/demo/report',
	)

	// 2. The owner subdomain exchanges the token for its own host-scoped cookie,
	// then bounces to the clean URL so the token stops travelling. The secure
	// cookie uses the `__Host-` prefix, so browsers refuse any variant carrying a
	// `Domain` attribute (cookie tossing from sibling subdomains).
	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	const setCookies = handoffResponse.headers.getSetCookie()
	const setCookie =
		setCookies.find((cookie) =>
			cookie.startsWith('__Host-kody_pkg_session_'),
		) ?? ''
	const cookieAttributes = [
		'__Host-kody_pkg_session_',
		'HttpOnly',
		'SameSite=Lax',
		'Secure',
		'Path=/',
	]
	expect(cookieAttributes.filter((part) => !setCookie.includes(part))).toEqual(
		[],
	)
	expect(setCookie).not.toContain('Domain=')
	expect(setCookie).not.toMatch(/^__Host-kody_pkg_session=/)
	const packageSessionMaxAge = Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])
	// Fresh non-remember-me `kody_session` is 7 days; the exchanged cookie
	// inherits that remaining time rather than a fixed 12-hour cap.
	expect(packageSessionMaxAge).toBeGreaterThan(7 * 24 * 60 * 60 - 30)
	expect(packageSessionMaxAge).toBeLessThanOrEqual(7 * 24 * 60 * 60)
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.origin).toBe(ownerPackageAppOrigin)
	expect(cleanLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)
	expect(cleanLocation.searchParams.get('tab')).toBe('1')
	const packageSessionCookie = setCookie.split(';')[0] ?? ''
	const withPackageSession = (headers: Record<string, string> = {}) => ({
		headers: { Cookie: packageSessionCookie, ...headers },
	})

	// 3. With the package-app session, requests reach package-app serving: the
	// org named in the host is resolved and the saved package lookup 404s (none
	// is seeded), which is distinct from the origin-level 404 below. A stale or
	// forged token next to a valid session is ignored and stripped before
	// serving. Sibling subdomains are same-site, so a Lax cookie would attach
	// to their cross-origin requests: a mutating request whose Origin is not
	// this subdomain is rejected before package code runs; same-origin passes.
	const staleTokenUrl = new URL(cleanLocation)
	staleTokenUrl.searchParams.set(packageAppHandoffQueryParam, `${handoffToken}`)
	const servingCases: Array<{
		name: string
		url: URL
		method?: string
		origin?: string
	}> = [
		{ name: 'clean URL', url: cleanLocation },
		{ name: 'stale token', url: staleTokenUrl },
		{
			name: 'same-origin POST',
			url: cleanLocation,
			method: 'POST',
			origin: ownerPackageAppOrigin,
		},
		{
			name: 'cross-origin OPTIONS',
			url: cleanLocation,
			method: 'OPTIONS',
			origin: 'https://other-user.packages.isolated.test',
		},
	]
	for (const { name, url, method, origin } of servingCases) {
		const response = await workerFetch(url, {
			...(method ? { method } : {}),
			...withPackageSession(origin ? { Origin: origin } : {}),
		})
		expect({ name, ...(await outcome(response)) }).toEqual({
			name,
			status: 404,
			body: buildPackageAppNotFoundMessage(),
		})
	}
	// A session on a handle with no org cannot invent an owner — fail closed
	// the same way a missing package-app session does.
	const otherUserSubdomain = await workerFetch(
		'https://other-user.packages.isolated.test/packages/demo',
		withPackageSession(),
	)
	expect(otherUserSubdomain.status).toBe(403)
	expect(otherUserSubdomain.headers.get('X-Kody-Handoff')).toBe('required')

	const crossOriginPost = await workerFetch(cleanLocation, {
		method: 'POST',
		...withPackageSession({
			Origin: 'https://other-user.packages.isolated.test',
		}),
	})
	expect(crossOriginPost.status).toBe(403)
	await expect(crossOriginPost.text()).resolves.toContain(
		'Cross-origin mutating requests',
	)

	// 4. The package-app session is re-checked against the account on every
	// request, so suspension and password changes revoke package-app access too.
	const ownerStableUserId = testStableUserIdFromEmail(ownerEmail)
	for (const [column, value] of [
		['suspended_at', new Date().toISOString()],
		['password_changed_at', new Date(Date.now() + 1000).toISOString()],
	] as const) {
		await env.APP_DB.prepare(`UPDATE users SET ${column} = ? WHERE email = ?`)
			.bind(value, ownerEmail)
			.run()
		invalidatePackageAppOwnerCache({ stableUserId: ownerStableUserId })
		const revoked = await workerFetch(cleanLocation, withPackageSession())
		expect({ column, status: revoked.status }).toEqual({ column, status: 403 })
		await env.APP_DB.prepare(
			`UPDATE users SET ${column} = NULL WHERE email = ?`,
		)
			.bind(ownerEmail)
			.run()
		invalidatePackageAppOwnerCache({ stableUserId: ownerStableUserId })
	}

	// 5. Replaying the consumed token is refused, and so is any request without a
	// package-app session. Both terminate here (never a redirect back to the app
	// origin) so a browser that drops the cookie cannot ping-pong between hosts.
	// The terminal page links to the app-origin entry path that restarts the
	// handoff. A presented-but-rejected token is not a cookie problem.
	const replayed = await workerFetch(handoffLocation)
	expect(replayed.status).toBe(403)
	expect(replayed.headers.get('Location')).toBeNull()
	expect(replayed.headers.get('X-Kody-Handoff')).toBe('rejected')
	const replayedBody = await replayed.text()
	expect(replayedBody).toContain(entryUrl)
	expect(replayedBody).toContain(
		'the package-app domain did not accept the token',
	)
	const missingSession = await workerFetch(cleanLocation)
	expect(missingSession.status).toBe(403)
	expect(missingSession.headers.get('X-Kody-Handoff')).toBe('required')
	const missingSessionBody = await missingSession.text()
	expect(missingSessionBody).toContain(entryUrl)
	expect(missingSessionBody).toContain('your browser is refusing this site')
	const rejectedJson = await workerFetch(cleanLocation, {
		headers: { Accept: 'application/json' },
	})
	expect(rejectedJson.status).toBe(403)
	await expect(rejectedJson.json()).resolves.toMatchObject({
		error: 'Package app session required',
	})

	// 6. Nothing first-party is reachable on the package-app domain (bare origin
	// or user subdomain), and hostnames that are not a valid username label fail
	// closed: wildcard DNS routes them here, but nothing serves.
	const unmatchedUrls = [
		...[packageAppOrigin, ownerPackageAppOrigin].flatMap((origin) =>
			[
				`/@${ownerUsername}/webhooks/demo/sentry/secret`,
				`/@${ownerUsername}/connectors/home/instance`,
				'/-/unknown',
				'/.well-known/unknown',
			].map((path) => `${origin}${path}`),
		),
		...['/account/secrets.json', '/login', '/mcp', '/session'].map(
			(path) => `${packageAppOrigin}${path}`,
		),
		'https://nested.label.packages.isolated.test/packages/demo',
		'https://Bad_Label.packages.isolated.test/packages/demo',
		'https://xy.packages.isolated.test/packages/demo',
	]
	const unmatched = buildUnmatchedPackageAppOriginPathMessage()
	for (const url of unmatchedUrls) {
		const response = await workerFetch(url, {
			headers: { Cookie: `${packageSessionCookie}; ${sessionCookie}` },
		})
		expect({ url, ...(await outcome(response)) }).toEqual({
			url,
			status: 404,
			body: unmatched,
		})
	}

	// 7. Legacy path-based URLs on the bare package-app origin redirect to the
	// owning user's subdomain (dropping any handoff token, keeping the query).
	const legacyUrl = new URL(
		`${packageAppOrigin}/@${ownerUsername}/packages/demo/report?tab=1`,
	)
	legacyUrl.searchParams.set(packageAppHandoffQueryParam, 'stale-token')
	const legacyResponse = await workerFetch(legacyUrl)
	expect(legacyResponse.status).toBe(302)
	expect(legacyResponse.headers.get('Location')).toBe(
		`${ownerPackageAppOrigin}/demo/report?tab=1`,
	)

	// 8. The bare package-app origin and a bare user subdomain are plausible
	// bookmarks; send them home.
	for (const origin of [packageAppOrigin, ownerPackageAppOrigin]) {
		const rootResponse = await workerFetch(`${origin}/`)
		expect(rootResponse.status).toBe(302)
		expect(rootResponse.headers.get('Location')).toBe(`${appOrigin}/`)
	}

	// 9. The package-app session is not an app session. A session-gated app
	// sends an anonymous visitor to login on the app origin, not to the
	// package-app host.
	const appOriginWithPackageCookie = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		withPackageSession(),
	)
	expect(appOriginWithPackageCookie.status).toBe(302)
	const packageCookieLogin = new URL(
		appOriginWithPackageCookie.headers.get('Location') ?? '',
	)
	expect(packageCookieLogin.origin).toBe(appOrigin)
	expect(packageCookieLogin.pathname).toBe('/login')

	// 10. A signed-in visitor on the owner-only handoff mount is sent to the
	// saved-package page (`/@{username}/{kodyId}`), not a "not found" 404.
	const visitorOnHandoffMount = await workerFetch(
		`${appOrigin}/@other-user/packages/demo/report`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(visitorOnHandoffMount.status).toBe(302)
	expect(visitorOnHandoffMount.headers.get('Location')).toBe(
		`${appOrigin}/@other-user/demo`,
	)
})

test('package-app hosts answer /-/health with the app origin health report', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	for (const origin of [packageAppOrigin, ownerPackageAppOrigin]) {
		const response = await workerFetch(`${origin}/-/health?format=json`)
		expect(response.status).toBe(200)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.has('X-App-Commit-Sha')).toBe(true)
		await expect(response.json()).resolves.toHaveProperty('ok')
	}
	const bareHealth = await workerFetch(`${ownerPackageAppOrigin}/health`, {
		headers: { Accept: 'application/json' },
	})
	expect(bareHealth.status).toBe(403)
	expect(bareHealth.headers.get('X-Kody-Handoff')).toBe('required')
})

test('user subdomain serves default robots.txt and 404s unknown .well-known', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const robots = await workerFetch(`${ownerPackageAppOrigin}/robots.txt`)
	expect(robots.status).toBe(200)
	expect(robots.headers.get('x-kody-default')).toBe('robots.txt')
	expect(robots.headers.get('Content-Type')).toMatch(/text\/plain/)
	await expect(robots.text()).resolves.toBe('User-agent: *\nAllow: /\n')

	const robotsHead = await workerFetch(`${ownerPackageAppOrigin}/robots.txt`, {
		method: 'HEAD',
	})
	expect(robotsHead.status).toBe(200)
	expect(robotsHead.headers.get('x-kody-default')).toBe('robots.txt')
	expect(await robotsHead.text()).toBe('')

	const wellKnown = await workerFetch(
		`${ownerPackageAppOrigin}/.well-known/security.txt`,
	)
	expect(wellKnown.status).toBe(404)
	await expect(wellKnown.text()).resolves.toBe(
		buildUnmatchedPackageAppOriginPathMessage(),
	)

	// Apex is not a short-path host; robots.txt stays unmatched there.
	const apexRobots = await workerFetch(`${packageAppOrigin}/robots.txt`)
	expect(apexRobots.status).toBe(404)
})

test('package apps stay inline on the app origin when no package-app origin is configured', async () => {
	configureOrigins({ packageAppBaseUrl: undefined, runtime: 'preview' })
	invalidatePackageAppOwnerCache({
		stableUserId: testStableUserIdFromEmail(ownerEmail),
	})
	const sessionCookie = await seedOwnerSessionCookie()

	const response = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: sessionCookie } },
	)
	// Served inline (no cross-origin redirect); the saved package does not exist.
	expect(response.status).toBe(404)
	await expect(response.text()).resolves.toBe(buildPackageAppNotFoundMessage())
})

test('production package apps fail closed when origin isolation is missing or unsafe', async () => {
	for (const packageAppBaseUrl of [
		undefined,
		appOrigin,
		'https://packages.kody.test',
	]) {
		configureOrigins({ packageAppBaseUrl, runtime: 'production' })
		const response = await workerFetch(
			`${appOrigin}/@${ownerUsername}/packages/demo`,
		)

		expect(response.status).toBe(500)
		expect(response.headers.get('Cache-Control')).toBe('no-store')
		expect(response.headers.get('Location')).toBeNull()
		await expect(response.text()).resolves.toContain(
			'Hosted package apps are unavailable.',
		)
	}

	// Defense in depth: even a future routing regression cannot call the inline
	// handler in production when the separate origin itself is configured safely.
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	consoleError.mockImplementation(() => {})
	const inlineResponse = await handlePackageAppRequest(
		new Request(`${appOrigin}/@${ownerUsername}/packages/demo`),
		env,
	)
	expect(consoleError).toHaveBeenCalledWith(
		'package-app-http-error',
		expect.objectContaining({
			status: 500,
			phase: 'inline-disabled',
			pathname: `/@${ownerUsername}/packages/demo`,
			runtimeRunId: null,
		}),
	)
	expect(inlineResponse.status).toBe(500)
	await expect(inlineResponse.text()).resolves.toContain(
		'Inline package-app serving is disabled in production.',
	)
})

test('createPackageCodeRequest drops credential headers in the workers runtime', async () => {
	const packageCodeRequest = createPackageCodeRequest(
		new Request(`${ownerPackageAppOrigin}/packages/demo/save`, {
			method: 'POST',
			headers: {
				Cookie: 'kody_session=owner; __Host-kody_pkg_session=package',
				Authorization: 'Bearer owner-token',
				'Proxy-Authorization': 'Basic owner',
				'X-Kody-Connector-Session-Key': 'internal',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ hello: 'world' }),
		}),
		new URL(`${ownerPackageAppOrigin}/save`),
	)

	expect(packageCodeRequest.url).toBe(`${ownerPackageAppOrigin}/save`)
	expect(
		[
			'Cookie',
			'Authorization',
			'Proxy-Authorization',
			'X-Kody-Connector-Session-Key',
		].filter((name) => packageCodeRequest.headers.has(name)),
	).toEqual([])
	expect(packageCodeRequest.headers.get('Content-Type')).toBe(
		'application/json',
	)
	await expect(packageCodeRequest.json()).resolves.toEqual({ hello: 'world' })
})

test('team org private apps hand off and open for owners and execute-granted members', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	await seedTeamOrgPackageAppFixture()
	const entryUrl = `${appOrigin}/@${teamOrgSlug}/packages/demo`

	async function expectHandoffAndServe(email: string) {
		const appOriginResponse = await workerFetch(entryUrl, {
			headers: { Cookie: await sessionCookieFor(email) },
		})
		expect(appOriginResponse.status).toBe(302)
		const handoffLocation = new URL(
			appOriginResponse.headers.get('Location') ?? '',
		)
		expect(handoffLocation.origin).toBe(teamPackageAppOrigin)
		expect(handoffLocation.pathname).toBe('/demo')
		expect(
			handoffLocation.searchParams.get(packageAppHandoffQueryParam),
		).toBeTruthy()

		const handoffResponse = await workerFetch(handoffLocation)
		expect(handoffResponse.status).toBe(302)
		const packageSessionCookie =
			handoffResponse.headers
				.getSetCookie()
				.find((cookie) => cookie.includes('kody_pkg_session_'))
				?.split(';')[0] ?? ''
		expect(packageSessionCookie).toContain('kody_pkg_session_')
		const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
		const served = await workerFetch(cleanLocation, {
			headers: { Cookie: packageSessionCookie },
		})
		// Auth is proven: session accepted on the org subdomain. No package
		// source is seeded, so serve 404s the same way the personal-org path
		// does after a successful handoff.
		expect(served.status).toBe(404)
		await expect(served.text()).resolves.toBe(buildPackageAppNotFoundMessage())
	}

	// Team org owner (username ≠ org slug) and a member with app:execute.
	await expectHandoffAndServe(teamOwnerEmail)
	await expectHandoffAndServe(teamRunnerEmail)

	// Personal org owner path still works when username == slug.
	const personalEntry = `${appOrigin}/@${teamOwnerUsername}/packages/demo`
	const personalHandoff = await workerFetch(personalEntry, {
		headers: { Cookie: await sessionCookieFor(teamOwnerEmail) },
	})
	expect(personalHandoff.status).toBe(302)
	expect(new URL(personalHandoff.headers.get('Location') ?? '').origin).toBe(
		`https://${teamOwnerUsername}.packages.isolated.test`,
	)

	for (const email of [teamReaderEmail, teamGuestEmail]) {
		const denied = await workerFetch(entryUrl, {
			headers: { Cookie: await sessionCookieFor(email) },
		})
		expect({ email, status: denied.status }).toEqual({
			email,
			status: 302,
		})
		expect(denied.headers.get('Location')).toBe(
			`${appOrigin}/@${teamOrgSlug}/demo`,
		)
	}
})

test('denied handoff for a real private package still redirects to the package page (no-access HTML is covered by package-page + e2e)', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	await seedTeamOrgPackageAppFixture()
	const now = '2026-10-14T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, '', '[]', NULL, ?, 1, 0, 1, ?, ?)`,
	)
		.bind(
			'pkg-acme-private-demo',
			teamOrgId,
			`@${teamOrgSlug}/demo`,
			'demo',
			'src-acme-private-demo',
			now,
			now,
		)
		.run()

	// Guest has no app:execute on the seeded private app. Handoff must not mint
	// a token; it sends them to `/@{org}/{kodyId}` where the package page now
	// renders an explicit no-access shell (see package-page + e2e coverage —
	// full Remix SSR needs AUTH_RATE_LIMITER, which this suite does not bind).
	const denied = await workerFetch(
		`${appOrigin}/@${teamOrgSlug}/packages/demo`,
		{ headers: { Cookie: await sessionCookieFor(teamGuestEmail) } },
	)
	expect(denied.status).toBe(302)
	expect(denied.headers.get('Location')).toBe(
		`${appOrigin}/@${teamOrgSlug}/demo`,
	)
	expect(denied.headers.get('Location')).not.toContain(
		packageAppHandoffQueryParam,
	)
})

test('internet-visible apps serve signed-out visitors anonymously; private apps stay gated', async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'Package app asset handler failed:',
		'package-app-http-error',
	])
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	await seedPackageAppAccessFixture()
	const { orgSlug, privateApp, publicApp } = accessFixture

	// App origin: a signed-out visitor of an internet-visible app stays on the
	// app origin. The package page would hide this private package, so the
	// response is a landing page that links to the real origin (path and query
	// preserved) and does not redirect.
	const publicEntry = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${publicApp.slug}?tab=1`,
	)
	expect(publicEntry.status).toBe(200)
	expect(publicEntry.headers.get('Location')).toBeNull()
	const publicBody = await publicEntry.text()
	const publicAppUrl = `${accessFixtureOrigin}/${publicApp.slug}?tab=1`
	expect(publicBody).toContain(publicAppUrl)
	expect(publicBody).toContain('data-testid="package-app-origin-link"')
	expect(publicBody).not.toContain(packageAppHandoffQueryParam)
	const privateEntry = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${privateApp.slug}`,
	)
	expect(privateEntry.status).toBe(302)
	const privateLogin = new URL(privateEntry.headers.get('Location') ?? '')
	expect(privateLogin.origin).toBe(appOrigin)
	expect(privateLogin.pathname).toBe('/login')

	// Package-app origin: anonymous requests to the internet-visible app clear
	// the gate and reach serve (500: the fixture has no published source).
	// Responses vary on Cookie so a cache never mixes anonymous and signed-in
	// variants.
	for (const path of [
		`/${publicApp.slug}`,
		`/${publicApp.slug}/_assets/app.js`,
		`/packages/${publicApp.slug}`,
		`/packages/${publicApp.slug}/_assets/app.js`,
	]) {
		const response = await workerFetch(`${accessFixtureOrigin}${path}`, {
			headers: { Accept: 'application/json' },
		})
		expect({ path, status: response.status }).toEqual({ path, status: 500 })
		expect(response.headers.get('Vary')).toContain('Cookie')
		await expect(response.json()).resolves.toMatchObject({
			error: 'Package app could not be prepared',
		})
	}
	const privateAnonymous = await workerFetch(
		`${accessFixtureOrigin}/packages/${privateApp.slug}`,
	)
	expect(privateAnonymous.status).toBe(403)
	expect(privateAnonymous.headers.get('X-Kody-Handoff')).toBe('required')

	// Internet-visible without an approved capability set stays on the app
	// origin. It is not a public app, so the visitor gets the package page.
	const unapprovedEntry = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${accessFixture.unapprovedPublicApp.slug}`,
	)
	const unapprovedLogin = new URL(unapprovedEntry.headers.get('Location') ?? '')
	expect(unapprovedLogin.origin).toBe(appOrigin)
	expect(unapprovedLogin.pathname).toBe('/login')
	const unapprovedAnonymous = await workerFetch(
		`${accessFixtureOrigin}/packages/${accessFixture.unapprovedPublicApp.slug}`,
	)
	expect(unapprovedAnonymous.status).toBe(403)
	expect(unapprovedAnonymous.headers.get('X-Kody-Handoff')).toBe('required')

	// Realtime hooks run as the owner, so anonymous visitors never reach them.
	const anonymousRealtime = await workerFetch(
		`${accessFixtureOrigin}/packages/${publicApp.slug}/ws`,
		{ headers: { Upgrade: 'websocket' } },
	)
	expect(anonymousRealtime.status).toBe(403)
	await expect(anonymousRealtime.text()).resolves.toBe(
		'Sign in to use realtime features of this app.',
	)

	// A session that cannot run the public app is served anonymously instead
	// of being bounced to the package page.
	const outsider = await sessionCookieForFixtureOutsider()
	const outsiderOnPublic = await workerFetch(
		`${accessFixtureOrigin}/packages/${publicApp.slug}`,
		{ headers: { Cookie: outsider, Accept: 'application/json' } },
	)
	expect(outsiderOnPublic.status).toBe(500)
	const outsiderOnPrivate = await workerFetch(
		`${accessFixtureOrigin}/packages/${privateApp.slug}`,
		{ headers: { Cookie: outsider } },
	)
	expect(outsiderOnPrivate.status).toBe(302)

	// A signed-in visitor's response is forced private.
	const member = await workerFetch(
		`${accessFixtureOrigin}/packages/${privateApp.slug}`,
		{
			headers: {
				Cookie: await packageAppSessionCookieFor('member'),
				Accept: 'application/json',
			},
		},
	)
	expect(member.status).toBe(500)
	expect(member.headers.get('Cache-Control')).toBe('private')
	expect(member.headers.get('Vary')).toContain('Cookie')

	// Signed-in outsiders on the app origin stay on the saved-package page,
	// including for an internet-visible app and for non-GET.
	const outsiderEmail = 'app-origin-outsider@example.com'
	await seedAccount({
		db: env.APP_DB,
		email: outsiderEmail,
		username: 'app-outsider',
	})
	const outsiderSession = await sessionCookieFor(outsiderEmail)
	const outsiderPublic = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${publicApp.slug}/play?tab=1`,
		{ headers: { Cookie: outsiderSession } },
	)
	expect(outsiderPublic.status).toBe(302)
	expect(outsiderPublic.headers.get('Location')).toBe(
		`${appOrigin}/@${orgSlug}/${publicApp.slug}`,
	)
	const outsiderPost = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${publicApp.slug}`,
		{ method: 'POST', headers: { Cookie: outsiderSession } },
	)
	expect(outsiderPost.status).toBe(303)
	expect(outsiderPost.headers.get('Location')).toBe(
		`${appOrigin}/@${orgSlug}/${publicApp.slug}`,
	)
	const anonymousPost = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${publicApp.slug}`,
		{ method: 'POST' },
	)
	expect(anonymousPost.status).toBe(303)
	expect(new URL(anonymousPost.headers.get('Location') ?? '').origin).toBe(
		appOrigin,
	)

	// People who may run the app still hand off. Other methods 307 without a
	// token, and only after the execute check.
	const ownerSession = await sessionCookieFor(accessFixture.people.owner.email)
	const ownerPost = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${privateApp.slug}?tab=1`,
		{ method: 'POST', headers: { Cookie: ownerSession } },
	)
	expect(ownerPost.status).toBe(307)
	const ownerPostLocation = new URL(ownerPost.headers.get('Location') ?? '')
	expect(ownerPostLocation.origin).toBe(accessFixtureOrigin)
	expect(ownerPostLocation.pathname).toBe(`/${privateApp.slug}`)
	expect(ownerPostLocation.searchParams.get('tab')).toBe('1')
	expect(ownerPostLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)

	// A public package with no community listing renders unauthorized and has
	// no app link, so both anonymous and signed-in visitors get the landing.
	const openSiteId = 'pkg-cost-open-site'
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, is_internet_visible,
			created_at, updated_at
		) VALUES (?, ?, ?, 'open-site', '', '[]', NULL, ?, 1, 0, 0, 1, ?, ?)`,
	)
		.bind(
			openSiteId,
			accessFixture.orgId,
			`@${orgSlug}/open-site`,
			`src-${openSiteId}`,
			'2026-10-14T00:00:00.000Z',
			'2026-10-14T00:00:00.000Z',
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO package_capability_approvals (
			id, package_id, owner_user_id, published_commit, fingerprint,
			capability_set_json, approved_by_user_id, approved_at, created_at
		) VALUES ('approval-cost-open-site', ?, ?, 'commit-open-site', 'fp-open', '[]', ?, ?, ?)`,
	)
		.bind(
			openSiteId,
			accessFixture.orgId,
			accessFixture.orgId,
			'2026-10-14T00:00:00.000Z',
			'2026-10-14T00:00:00.000Z',
		)
		.run()
	const openSiteHeaders: Array<HeadersInit> = [{}, { Cookie: outsiderSession }]
	for (const headers of openSiteHeaders) {
		const openSite = await workerFetch(
			`${appOrigin}/@${orgSlug}/packages/open-site`,
			{ headers },
		)
		expect(openSite.status).toBe(200)
		expect(openSite.headers.get('Location')).toBeNull()
		await expect(openSite.text()).resolves.toContain(
			`${accessFixtureOrigin}/open-site`,
		)
	}
})

async function sessionCookieForFixtureOutsider() {
	const email = 'cost-outsider@example.com'
	await seedAccount({ db: env.APP_DB, email, username: 'cost-outsider' })
	const setCookies = await createPackageAppSessionCookie({
		env,
		session: {
			stableUserId: testStableUserIdFromEmail(email),
			username: accessFixture.orgSlug,
		},
		slug: accessFixture.privateApp.slug,
		secure: true,
		expiresAt: Date.now() + 60 * 60 * 1000,
	})
	return setCookies[0]?.split(';')[0] ?? ''
}
