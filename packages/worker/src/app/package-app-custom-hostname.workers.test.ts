import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import { buildPackageAppNotFoundMessage } from '#worker/package-runtime/package-app-synthetic.ts'
import { packageAppCustomDomainsFlagKey } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	accessFixture,
	accessFixtureOrigin,
	seedPackageAppAccessFixture,
} from '#worker/test-support/package-app-access-fixture.ts'

const appOrigin = 'https://app.kody.test:8788'
const packageAppOrigin = 'https://packages.isolated.test'
const ownerEmail = 'custom-host-owner@example.com'
const ownerUsername = 'customhost'
const customHostname = 'app.customer-test.example'
const customOrigin = `https://${customHostname}`
const packageId = 'pkg-custom-demo'
const ownerPackageAppOrigin = `https://${ownerUsername}.packages.isolated.test`

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = packageAppOrigin
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
}

async function workerFetch(url: string | URL, init: RequestInit = {}) {
	return await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
	)
}

async function seedOwnerSessionCookie() {
	await ensureAuditEventsTestSchema(env.AUDIT_DB)
	await ensureRbacTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
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

async function ensureCustomHostnameSchema() {
	// Workers-unit D1 starts empty; suites create the tables they touch.
	// Production applies migration 0128. CREATE IF NOT EXISTS covers both.
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS feature_flags (
			key TEXT PRIMARY KEY NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 0,
			rollout_percent INTEGER,
			note TEXT NOT NULL DEFAULT '',
			audience TEXT NOT NULL DEFAULT 'everyone',
			updated_by INTEGER,
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_app_custom_hostnames (
			id TEXT PRIMARY KEY NOT NULL,
			hostname TEXT NOT NULL,
			binding_kind TEXT NOT NULL CHECK (binding_kind IN ('app', 'org')),
			package_id TEXT,
			org_id TEXT,
			cloudflare_hostname_id TEXT,
			cloudflare_zone_id TEXT,
			hostname_status TEXT NOT NULL DEFAULT 'pending',
			ssl_status TEXT NOT NULL DEFAULT 'pending',
			verified_at TEXT,
			dns_missing_since TEXT,
			created_by_user_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			CHECK (
				(
					binding_kind = 'app'
					AND package_id IS NOT NULL
					AND org_id IS NULL
				)
				OR (
					binding_kind = 'org'
					AND org_id IS NOT NULL
					AND package_id IS NULL
				)
			),
			CHECK (hostname = lower(hostname)),
			FOREIGN KEY (package_id) REFERENCES saved_packages (id) ON DELETE CASCADE,
			FOREIGN KEY (org_id) REFERENCES orgs (id) ON DELETE CASCADE
		)`,
	).run()
	await env.APP_DB.prepare(
		`CREATE UNIQUE INDEX IF NOT EXISTS package_app_custom_hostnames_hostname_idx
			ON package_app_custom_hostnames (hostname)`,
	).run()
}

async function seedCustomHostnamePackage() {
	await ensureCustomHostnameSchema()
	const ownerId = testStableUserIdFromEmail(ownerEmail)
	const now = '2026-10-13T00:00:00.000Z'
	await env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE hostname = ?`,
	)
		.bind(customHostname)
		.run()
	await env.APP_DB.prepare(`DELETE FROM saved_packages WHERE id = ?`)
		.bind(packageId)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 1, 0, 1, ?, ?)`,
	)
		.bind(
			packageId,
			ownerId,
			`@${ownerUsername}/demo`,
			'demo',
			'Custom hostname package.',
			`source-${packageId}`,
			now,
			now,
		)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO package_app_custom_hostnames (
			id, hostname, binding_kind, package_id, org_id,
			hostname_status, ssl_status, verified_at, created_at, updated_at
		) VALUES (?, ?, 'app', ?, NULL, 'active', 'active', ?, ?, ?)`,
	)
		.bind(`host-${packageId}`, customHostname, packageId, now, now, now)
		.run()
}

async function setCustomDomainsFlag(enabled: boolean) {
	await ensureCustomHostnameSchema()
	await env.APP_DB.prepare(
		`INSERT INTO feature_flags (key, enabled, note, audience, updated_at)
		 VALUES (?, ?, '', 'everyone', CURRENT_TIMESTAMP)
		 ON CONFLICT(key) DO UPDATE SET
			enabled = excluded.enabled,
			updated_at = CURRENT_TIMESTAMP`,
	)
		.bind(packageAppCustomDomainsFlagKey, enabled ? 1 : 0)
		.run()
}

test('custom hostnames stay refused and handoff stays on the user subdomain when the flag is off', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	await seedCustomHostnamePackage()
	await setCustomDomainsFlag(false)

	const customHost = await workerFetch(`${customOrigin}/`)
	expect(customHost.status).toBe(404)
	await expect(customHost.json()).resolves.toEqual({ error: 'not_found' })

	const appOriginResponse = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(appOriginResponse.status).toBe(302)
	const location = new URL(appOriginResponse.headers.get('Location') ?? '')
	expect(location.origin).toBe(ownerPackageAppOrigin)
	expect(location.pathname).toBe('/demo')
	expect(location.searchParams.get(packageAppHandoffQueryParam)).toBeTruthy()
})

test('anonymous and signed-in outsiders are not redirected to an app custom hostname', async () => {
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	await seedCustomHostnamePackage()
	await setCustomDomainsFlag(true)
	const outsiderEmail = 'custom-host-outsider@example.com'
	await seedAccount({
		db: env.APP_DB,
		email: outsiderEmail,
		username: 'customoutsider',
	})
	setAuthSessionSecret(env.COOKIE_SECRET)
	const outsiderCookie = (
		await createAuthCookie(
			{
				stableUserId: testStableUserIdFromEmail(outsiderEmail),
				email: outsiderEmail,
				rememberMe: false,
			},
			true,
		)
	).split(';')[0]

	const packagePage = `${appOrigin}/@${ownerUsername}/demo`
	const anonymousGet = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo?tab=1`,
	)
	const anonymousLogin = new URL(anonymousGet.headers.get('Location') ?? '')
	expect(anonymousGet.status).toBe(302)
	expect(anonymousLogin.origin).toBe(appOrigin)
	expect(anonymousLogin.pathname).toBe('/login')
	expect(anonymousLogin.href).not.toContain(customHostname)
	for (const [name, init, status] of [
		['outsider GET', { headers: { Cookie: outsiderCookie ?? '' } }, 302],
		['anonymous POST', { method: 'POST' }, 303],
		[
			'outsider POST',
			{ method: 'POST', headers: { Cookie: outsiderCookie ?? '' } },
			303,
		],
	] as const) {
		const response = await workerFetch(
			`${appOrigin}/@${ownerUsername}/packages/demo?tab=1`,
			init,
		)
		const location = response.headers.get('Location') ?? ''
		expect({ name, status: response.status, location }).toEqual({
			name,
			status,
			location: packagePage,
		})
		expect(location).not.toContain(customHostname)
	}

	// The owner still hands off onto the custom hostname.
	const ownerResponse = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo`,
		{ headers: { Cookie: sessionCookie } },
	)
	expect(ownerResponse.status).toBe(302)
	expect(new URL(ownerResponse.headers.get('Location') ?? '').origin).toBe(
		customOrigin,
	)
	await setCustomDomainsFlag(false)
})

test('an internet-visible app links at its custom hostname without redirecting', async () => {
	configureOrigins()
	await seedOwnerSessionCookie()
	await seedCustomHostnamePackage()
	await setCustomDomainsFlag(true)
	try {
		await env.APP_DB.prepare(
			`ALTER TABLE saved_packages ADD COLUMN is_internet_visible INTEGER NOT NULL DEFAULT 0`,
		).run()
	} catch {
		// Column already present.
	}
	// A new slug avoids the package-app slug cache filled by the private-app
	// request earlier in this file.
	await env.APP_DB.prepare(
		`UPDATE saved_packages
		 SET is_internet_visible = 1, kody_id = 'demo-public', name = ?
		 WHERE id = ?`,
	)
		.bind(`@${ownerUsername}/demo-public`, packageId)
		.run()
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS package_capability_approvals (
			id TEXT PRIMARY KEY NOT NULL,
			package_id TEXT NOT NULL,
			owner_user_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			capability_set_json TEXT NOT NULL,
			dependency_snapshot_json TEXT NOT NULL DEFAULT '{}',
			approved_by_user_id TEXT NOT NULL,
			approved_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		)`,
	).run()
	const ownerId = testStableUserIdFromEmail(ownerEmail)
	const now = '2026-10-13T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO package_capability_approvals (
			id, package_id, owner_user_id, published_commit, fingerprint,
			capability_set_json, approved_by_user_id, approved_at, created_at
		) VALUES ('approval-custom-demo', ?, ?, 'commit-custom', 'fp', '[]', ?, ?, ?)`,
	)
		.bind(packageId, ownerId, ownerId, now, now)
		.run()

	const response = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo-public/play?x=1`,
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Location')).toBeNull()
	const body = await response.text()
	expect(body).toContain(`${customOrigin}/play?x=1`)
	expect(body).not.toContain(ownerPackageAppOrigin)
	const post = await workerFetch(
		`${appOrigin}/@${ownerUsername}/packages/demo-public/play`,
		{ method: 'DELETE' },
	)
	expect(post.status).toBe(303)
	expect(new URL(post.headers.get('Location') ?? '').origin).toBe(appOrigin)
	await setCustomDomainsFlag(false)
})

test('a verified app custom hostname serves at / behind the same host-only handoff', async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'package-app-http-error',
	])
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()
	await seedCustomHostnamePackage()
	await setCustomDomainsFlag(true)
	const entryUrl = `${appOrigin}/@${ownerUsername}/packages/demo`

	const missingSession = await workerFetch(`${customOrigin}/`)
	expect(missingSession.status).toBe(403)
	expect(missingSession.headers.get('X-Kody-Handoff')).toBe('required')
	const missingSessionBody = await missingSession.text()
	expect(missingSessionBody).toContain(entryUrl)

	const appOriginResponse = await workerFetch(entryUrl, {
		headers: { Cookie: sessionCookie },
	})
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(customOrigin)
	expect(handoffLocation.pathname).toBe('/')
	expect(
		handoffLocation.searchParams.get(packageAppHandoffQueryParam),
	).toBeTruthy()
	expect(handoffLocation.host).not.toContain(ownerUsername)

	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	const setCookies = handoffResponse.headers.getSetCookie()
	const setCookie =
		setCookies.find((cookie) =>
			cookie.startsWith('__Host-kody_pkg_session_'),
		) ?? ''
	expect(setCookie).toContain('__Host-kody_pkg_session_')
	expect(setCookie).not.toContain('Domain=')
	expect(setCookie).not.toMatch(/^__Host-kody_pkg_session=/)
	const cleanLocation = new URL(handoffResponse.headers.get('Location') ?? '')
	expect(cleanLocation.origin).toBe(customOrigin)
	expect(cleanLocation.pathname).toBe('/')
	expect(cleanLocation.searchParams.has(packageAppHandoffQueryParam)).toBe(
		false,
	)

	const packageSessionCookie = setCookie.split(';')[0] ?? ''
	const served = await workerFetch(`${customOrigin}/`, {
		headers: { Cookie: packageSessionCookie },
	})
	// Auth and mount are proven: session accepted on the custom host, no
	// handoff bounce. Workers-unit D1 does not seed a full package source, so
	// serve may 404 (missing app) or 500 (host-setup); either means we passed
	// the session gate. A 403/302 would mean handoff/session failed.
	expect([404, 500]).toContain(served.status)
	expect(served.headers.get('X-Kody-Handoff')).toBeNull()
	expect(served.headers.get('Location')).toBeNull()
	const servedBody = await served.text()
	if (served.status === 404) {
		expect(servedBody).toBe(buildPackageAppNotFoundMessage())
	}

	// OPTIONS is a preflight, not a mutation, so a foreign Origin still reaches
	// the app gate. POST from that Origin stays blocked.
	const crossOriginOptions = await workerFetch(`${customOrigin}/`, {
		method: 'OPTIONS',
		headers: {
			Cookie: packageSessionCookie,
			Origin: 'https://example.com',
		},
	})
	expect(crossOriginOptions.headers.get('X-Kody-Handoff')).toBeNull()
	await expect(crossOriginOptions.text()).resolves.not.toContain(
		'Cross-origin mutating requests',
	)
	const crossOriginPost = await workerFetch(`${customOrigin}/`, {
		method: 'POST',
		headers: {
			Cookie: packageSessionCookie,
			Origin: 'https://example.com',
		},
	})
	expect(crossOriginPost.status).toBe(403)
	await expect(crossOriginPost.text()).resolves.toContain(
		'Cross-origin mutating requests to a package-app custom hostname are not allowed.',
	)

	await setCustomDomainsFlag(false)
})

test('internet-visible apps skip an org-level custom hostname and go to the subdomain', async () => {
	configureOrigins()
	await seedPackageAppAccessFixture()
	await ensureCustomHostnameSchema()
	await setCustomDomainsFlag(true)
	const { orgId, orgSlug, privateApp, publicApp } = accessFixture
	const orgHostname = 'apps.cost-org-test.example'
	const now = '2026-10-14T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT OR IGNORE INTO package_app_custom_hostnames (
			id, hostname, binding_kind, package_id, org_id,
			hostname_status, ssl_status, verified_at, created_at, updated_at
		) VALUES ('host-cost-org', ?, 'org', NULL, ?, 'active', 'active', ?, ?, ?)`,
	)
		.bind(orgHostname, orgId, now, now, now)
		.run()

	// Session-gated apps still hand off to the org domain.
	const memberSession = await createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail(
				accessFixture.people.member.email,
			),
			email: accessFixture.people.member.email,
			rememberMe: false,
		},
		true,
	)
	const privateEntry = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${privateApp.slug}`,
		{ headers: { Cookie: memberSession.split(';')[0] ?? '' } },
	)
	expect(new URL(privateEntry.headers.get('Location') ?? '').host).toBe(
		orgHostname,
	)

	// The org domain serves only session-gated apps. A signed-out visitor of
	// an internet-visible app is not redirected there or to the subdomain;
	// the page links at the subdomain.
	const publicEntry = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${publicApp.slug}`,
	)
	expect(publicEntry.status).toBe(200)
	expect(publicEntry.headers.get('Location')).toBeNull()
	const publicBody = await publicEntry.text()
	expect(publicBody).toContain(`${accessFixtureOrigin}/${publicApp.slug}`)
	expect(publicBody).not.toContain(orgHostname)
	const publicPost = await workerFetch(
		`${appOrigin}/@${orgSlug}/packages/${publicApp.slug}`,
		{ method: 'POST' },
	)
	expect(publicPost.status).toBe(303)
	expect(new URL(publicPost.headers.get('Location') ?? '').origin).toBe(
		appOrigin,
	)

	await env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE id = 'host-cost-org'`,
	).run()
	await setCustomDomainsFlag(false)
})
