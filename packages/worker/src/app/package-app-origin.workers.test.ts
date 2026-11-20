import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, test } from 'vitest'
import { ensurePackageAppCustomHostnamesTestSchema } from '#worker/test-support/package-app-custom-hostnames-test-schema.ts'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createPackageCodeRequest,
	handlePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import {
	approvePackageAppRun,
	listPackageAppRunApprovals,
	removePackageAppRunApproval,
} from '#app/package-app-run-consent.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { buildUnmatchedPackageAppOriginPathMessage } from '#worker/package-runtime/package-app-synthetic.ts'
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

beforeEach(async () => {
	await ensurePackageAppCustomHostnamesTestSchema()
})

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
		const { status, body } = await outcome(response)
		expect({ name, status }).toEqual({ name, status: 404 })
		expect(body).toContain('Saved package app not found')
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

	// CORS does not cover WebSockets, so a cross-origin realtime upgrade that
	// carries the Lax session cookie is refused like a mutating request.
	const crossOriginUpgrade = await workerFetch(
		new URL('/demo/ws', cleanLocation),
		withPackageSession({
			Upgrade: 'websocket',
			Origin: 'https://other-user.packages.isolated.test',
		}),
	)
	expect(crossOriginUpgrade.status).toBe(403)
	await expect(crossOriginUpgrade.text()).resolves.toContain(
		'Cross-origin mutating requests',
	)
	const sameOriginUpgrade = await workerFetch(
		new URL('/demo/ws', cleanLocation),
		withPackageSession({ Upgrade: 'websocket', Origin: ownerPackageAppOrigin }),
	)
	expect(sameOriginUpgrade.status).toBe(404)

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

test('a package app serves at the root of its own {leaf}--{handle} host and signs in back to it', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const sessionCookie = await seedOwnerSessionCookie()
	const appHostOrigin = `https://demo--${ownerUsername}.packages.isolated.test`

	// 1. No session: the terminal page links to the app origin, marked so the
	// handoff comes back to this host instead of the owner's shared subdomain.
	const signedOut = await workerFetch(`${appHostOrigin}/report?tab=1`, {
		headers: { Accept: 'application/json' },
	})
	expect(signedOut.status).toBe(403)
	const nextStep = ((await signedOut.json()) as { next_step: string }).next_step
	const entryUrl = new URL(
		/https:\/\/\S+/.exec(nextStep)?.[0].replace(/\.$/, '') ?? '',
	)
	expect(`${entryUrl.origin}${entryUrl.pathname}`).toBe(
		`${appOrigin}/@${ownerUsername}/packages/demo/open/report`,
	)
	expect(entryUrl.searchParams.get('tab')).toBe('1')

	// 2. The app origin hands off to the app host root: no `/demo` prefix, the
	// query is kept and the marker does not reach the app.
	const appOriginResponse = await workerFetch(entryUrl, {
		headers: { Cookie: sessionCookie },
	})
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(appHostOrigin)
	expect(handoffLocation.pathname).toBe('/report')
	expect([...handoffLocation.searchParams.keys()].sort()).toEqual(
		[packageAppHandoffQueryParam, 'tab'].sort(),
	)

	// An unmarked entry URL still hands off to the owner's shared subdomain.
	const unmarked = new URL(entryUrl)
	unmarked.search = ''
	const unmarkedResponse = await workerFetch(unmarked, {
		headers: { Cookie: sessionCookie },
	})
	expect(new URL(unmarkedResponse.headers.get('Location') ?? '').origin).toBe(
		ownerPackageAppOrigin,
	)

	// 3. The app host exchanges the token for its own host-only cookie.
	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	const setCookie =
		handoffResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith('__Host-kody_pkg_session_')) ?? ''
	expect(setCookie).not.toContain('Domain=')
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.toString()).toBe(`${appHostOrigin}/report?tab=1`)
	const packageSessionCookie = setCookie.split(';')[0] ?? ''

	// 4. With the session, requests reach package-app serving for the app named
	// by the host (none is seeded, so the saved package lookup 404s). A
	// cross-origin mutating request, including one from the owner's shared
	// subdomain, is refused before package code runs.
	const served = await outcome(
		await workerFetch(cleanLocation, {
			headers: { Cookie: packageSessionCookie },
		}),
	)
	expect(served.status).toBe(404)
	expect(served.body).toContain('Saved package app not found')
	const crossOrigin = await workerFetch(cleanLocation, {
		method: 'POST',
		headers: { Cookie: packageSessionCookie, Origin: ownerPackageAppOrigin },
	})
	expect(crossOrigin.status).toBe(403)

	// 5. Platform routes stay under `/-/`, and labels that are not an app host
	// fail closed.
	expect((await workerFetch(`${appHostOrigin}/-/health`)).status).toBe(200)
	expect(
		(await workerFetch(`https://xn--${ownerUsername}.packages.isolated.test/`))
			.status,
	).toBe(404)
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
				Cookie: 'kody_session=owner; __Host-kody_pkg_session_testhash=package',
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
		await expect(served.text()).resolves.toContain(
			'Saved package app not found',
		)
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

test('shared app confirmation gates handoff and blocks a previously established session after removal', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	await seedPackageAppAccessFixture()
	const { privateApp, orgSlug, people } = accessFixture
	const personId = personIdFromStored(
		testStableUserIdFromEmail(people.collaborator.email),
	)
	const cookie = await sessionCookieFor(people.collaborator.email)
	const entry = `${appOrigin}/@${orgSlug}/packages/${privateApp.slug}/open/report?tab=1`
	const navigate = () =>
		workerFetch(entry, { headers: { Cookie: cookie, Accept: 'text/html' } })
	const ask = await navigate()
	expect(ask.status).toBe(302)
	expect(ask.headers.getSetCookie()).toEqual([])
	const consent = new URL(ask.headers.get('Location') ?? '')
	expect(consent.origin).toBe(appOrigin)
	expect(consent.pathname).toBe('/oauth/package-app/run-as-me')
	expect(consent.searchParams.get('returnTo')).toBe(
		new URL(entry).pathname + '?tab=1',
	)
	await expect(
		listPackageAppRunApprovals(env.APP_DB, personId),
	).resolves.toEqual([])

	await approvePackageAppRun(env.APP_DB, personId, privateApp.id)
	await approvePackageAppRun(env.APP_DB, personId, privateApp.id)
	await expect(
		listPackageAppRunApprovals(env.APP_DB, personId),
	).resolves.toEqual([
		expect.objectContaining({ packageId: privateApp.id, publisher: orgSlug }),
	])
	const handoff = new URL((await navigate()).headers.get('Location') ?? '')
	expect(handoff.origin).toBe(accessFixtureOrigin)
	expect(handoff.pathname).toBe(`/${privateApp.slug}/report`)
	expect(handoff.searchParams.get(packageAppHandoffQueryParam)).toBeTruthy()
	const exchange = await workerFetch(handoff)
	expect(exchange.status).toBe(302)
	expect(
		exchange.headers
			.getSetCookie()
			.some((value) => value.startsWith('__Host-kody_pkg_session_')),
	).toBe(true)
	const hostedUrl = exchange.headers.get('Location') ?? ''
	const session = exchange.headers.getSetCookie()[0]?.split(';')[0] ?? ''

	// An in-flight handoff must not mint another session after approval is removed.
	const pendingHandoff = (await navigate()).headers.get('Location') ?? ''
	await removePackageAppRunApproval(env.APP_DB, personId, privateApp.id)
	const blockedExchange = await workerFetch(pendingHandoff, {
		headers: { Accept: 'text/html' },
	})
	expect(blockedExchange.headers.get('Location')).toBe(consent.toString())
	expect(blockedExchange.headers.getSetCookie()).toEqual([])
	expect((await navigate()).headers.get('Location')).toBe(consent.toString())
	const blockedRequest = await workerFetch(hostedUrl, {
		headers: { Cookie: session, Accept: 'application/json' },
	})
	expect(blockedRequest.status).toBe(403)
	expect(blockedRequest.headers.getSetCookie()).toEqual([])
	await expect(blockedRequest.json()).resolves.toMatchObject({
		error: 'app_run_confirmation_required',
	})
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
		'Package realtime handler failed:',
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

	// Anonymous realtime on an internet-visible app clears the gate and reaches
	// the `kody.app.realtime.anonymous` check, which reads the published
	// manifest (500: the fixture has no published source). The opt-in and pin
	// decision itself is covered by package-app-public-realtime.node.test.ts.
	const anonymousRealtime = await workerFetch(
		`${accessFixtureOrigin}/packages/${publicApp.slug}/ws`,
		{ headers: { Upgrade: 'websocket', Accept: 'application/json' } },
	)
	expect(anonymousRealtime.status).toBe(500)
	expect(await anonymousRealtime.text()).not.toContain('Sign in')

	// A session that cannot run the public app is served anonymously instead
	// of being bounced to the package page.
	const outsider = await sessionCookieForFixtureOutsider()
	const outsiderOnPublic = await workerFetch(
		`${accessFixtureOrigin}/packages/${publicApp.slug}`,
		{ headers: { Cookie: outsider, Accept: 'application/json' } },
	)
	expect(outsiderOnPublic.status).toBe(500)
	expect(outsiderOnPublic.headers.get('Cache-Control') ?? '').not.toContain(
		'private',
	)

	// Changed deliberately (identity-only visitors): an outsider who signed in
	// to the public app with Kody is still served as an anonymous visitor, but
	// the response may name them, so it is forced private. Without a live
	// grant (or after revoking it) they are plain anonymous again.
	await ensurePackageAppOauthGrantsTable()
	const signedInOutsider = await sessionCookieForFixtureOutsider(publicApp.slug)
	const fetchPublicAsSignedInOutsider = () =>
		workerFetch(`${accessFixtureOrigin}/packages/${publicApp.slug}`, {
			headers: { Cookie: signedInOutsider, Accept: 'application/json' },
		})
	const beforeGrant = await fetchPublicAsSignedInOutsider()
	expect(beforeGrant.status).toBe(500)
	expect(beforeGrant.headers.get('Cache-Control') ?? '').not.toContain(
		'private',
	)
	await grantFixtureOutsiderSignIn(publicApp.slug)
	const withGrant = await fetchPublicAsSignedInOutsider()
	expect(withGrant.status).toBe(500)
	expect(withGrant.headers.get('Cache-Control')).toContain('private')
	expect(withGrant.headers.get('Vary')).toContain('Cookie')
	await revokeFixtureOutsiderSignIn(publicApp.slug)
	const afterRevoke = await fetchPublicAsSignedInOutsider()
	expect(afterRevoke.headers.get('Cache-Control') ?? '').not.toContain(
		'private',
	)
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
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			serving_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, 'commit-open-site', 'commit-open-site',
			'package.json', '/', ?, ?)`,
	)
		.bind(
			`src-${openSiteId}`,
			accessFixture.orgId,
			openSiteId,
			`repo-${openSiteId}`,
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

const fixtureOutsiderEmail = 'cost-outsider@example.com'

async function ensurePackageAppOauthGrantsTable() {
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
}

async function grantFixtureOutsiderSignIn(slug: string) {
	await env.APP_DB.prepare(
		`INSERT INTO package_app_oauth_grants (
			id, person_id, org_username, kody_id, scopes, created_at
		) VALUES (?, ?, ?, ?, 'profile', ?)`,
	)
		.bind(
			`grant-outsider-${slug}`,
			testStableUserIdFromEmail(fixtureOutsiderEmail),
			accessFixture.orgSlug,
			slug,
			new Date().toISOString(),
		)
		.run()
}

async function revokeFixtureOutsiderSignIn(slug: string) {
	await env.APP_DB.prepare(
		`UPDATE package_app_oauth_grants SET revoked_at = ? WHERE id = ?`,
	)
		.bind(new Date().toISOString(), `grant-outsider-${slug}`)
		.run()
}

async function sessionCookieForFixtureOutsider(
	slug: string = accessFixture.privateApp.slug,
) {
	const email = fixtureOutsiderEmail
	await seedAccount({ db: env.APP_DB, email, username: 'cost-outsider' })
	const setCookies = await createPackageAppSessionCookie({
		env,
		session: {
			stableUserId: testStableUserIdFromEmail(email),
			username: accessFixture.orgSlug,
		},
		slug,
		secure: true,
		expiresAt: Date.now() + 60 * 60 * 1000,
	})
	return setCookies[0]?.split(';')[0] ?? ''
}

test('from the cutover the path address answers every method with a 308 to the app host', async () => {
	configureOrigins({
		packageAppBaseUrl: packageAppOrigin,
		runtime: 'production',
	})
	const sessionCookie = await seedOwnerSessionCookie()
	const mutableEnv = env as unknown as Record<string, string | undefined>
	const appHostOrigin = `https://demo--${ownerUsername}.packages.isolated.test`
	const pathAddress = `${ownerPackageAppOrigin}/demo/report?tab=1`
	try {
		// Before the cutover moment the path address is still served (a signed-out
		// request reaches the app gate, not a redirect).
		mutableEnv.PACKAGE_APP_PATH_MOUNT_CUTOVER_AT = new Date(Date.now() + 60_000)
			.toISOString()
			.replace(/\.\d{3}Z$/, 'Z')
		const before = await workerFetch(pathAddress, {
			headers: { Accept: 'application/json' },
		})
		expect(before.status).toBe(403)

		mutableEnv.PACKAGE_APP_PATH_MOUNT_CUTOVER_AT = '2020-01-01T00:00:00Z'
		for (const method of ['GET', 'POST', 'DELETE']) {
			const after = await workerFetch(pathAddress, { method })
			expect(after.status).toBe(308)
			expect(after.headers.get('Location')).toBe(
				`${appHostOrigin}/report?tab=1`,
			)
		}
		const legacyMount = await workerFetch(
			`${ownerPackageAppOrigin}/packages/demo/report`,
			{ method: 'POST' },
		)
		expect(legacyMount.status).toBe(308)
		expect(legacyMount.headers.get('Location')).toBe(`${appHostOrigin}/report`)

		// Reserved platform paths stay on the owner's host.
		const health = await workerFetch(`${ownerPackageAppOrigin}/-/health`)
		expect(health.status).not.toBe(308)

		// "Open app" hands off straight to the app host, not through the redirect.
		const open = await workerFetch(
			`${appOrigin}/@${ownerUsername}/packages/demo/open/report`,
			{ headers: { Cookie: sessionCookie } },
		)
		expect(open.status).toBe(302)
		const handoff = new URL(open.headers.get('Location') ?? '')
		expect(handoff.origin).toBe(appHostOrigin)
		expect(handoff.pathname).toBe('/report')
	} finally {
		delete mutableEnv.PACKAGE_APP_PATH_MOUNT_CUTOVER_AT
	}
})
