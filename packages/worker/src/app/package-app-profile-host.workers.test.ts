import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ensureAuditEventsTestSchema } from '#worker/test-support/audit-events-test-schema.ts'
import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import { invalidateInvokeContractFreshness } from '#worker/package-invocations/invoke-contract-cache.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { silenceExpectedConsoleErrors } from '#worker/test-support/console-spies.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { ensurePackageAppCustomHostnamesTestSchema } from '#worker/test-support/package-app-custom-hostnames-test-schema.ts'

const appOrigin = 'https://app.kody.test:8788'
const ownerEmail = 'profile-owner@example.com'
const ownerUsername = 'profileowner'
const profileOrigin = `https://${ownerUsername}.packages.isolated.test`
const profilePackageId = 'pkg-profile-owner'

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = appOrigin
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
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
	await ensurePackageAppCustomHostnamesTestSchema()
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

async function deleteProfilePackage() {
	await env.APP_DB.prepare(`DELETE FROM saved_packages WHERE id = ?`)
		.bind(profilePackageId)
		.run()
	// Delete and unpublish flows evict the lookup cache the same way.
	invalidateInvokeContractFreshness({
		userId: testStableUserIdFromEmail(ownerEmail),
		packageIdOrKodyIds: [profilePackageId],
		packageAppSlugs: [ownerUsername],
	})
}

async function seedProfilePackage() {
	await deleteProfilePackage()
	const now = '2026-11-15T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 1, 0, 1, ?, ?)`,
	)
		.bind(
			profilePackageId,
			testStableUserIdFromEmail(ownerEmail),
			`@${ownerUsername}/${ownerUsername}`,
			ownerUsername,
			'Profile package.',
			`source-${profilePackageId}`,
			now,
			now,
		)
		.run()
}

test('a profile package owns every path on the owner host except /-/', async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'package-app-http-error',
	])
	configureOrigins()
	const sessionCookie = await seedOwnerSessionCookie()

	// Without a profile package the host keeps its default behavior.
	await deleteProfilePackage()
	const bareWithout = await workerFetch(`${profileOrigin}/`)
	expect(bareWithout.status).toBe(302)
	expect(bareWithout.headers.get('Location')).toBe(`${appOrigin}/`)

	await seedProfilePackage()

	// An old sibling path is the profile app's own path: no 308, no prefix
	// stripping, and sign-in comes back to the same path on this host.
	const signedOut = await workerFetch(`${profileOrigin}/demo/x?tab=1`, {
		headers: { Accept: 'application/json' },
	})
	expect(signedOut.status).toBe(403)
	const nextStep = ((await signedOut.json()) as { next_step: string }).next_step
	const entryUrl = new URL(
		/https:\/\/\S+/.exec(nextStep)?.[0].replace(/\.$/, '') ?? '',
	)
	expect(`${entryUrl.origin}${entryUrl.pathname}`).toBe(
		`${appOrigin}/@${ownerUsername}/packages/${ownerUsername}/open/demo/x`,
	)
	const appOriginResponse = await workerFetch(entryUrl, {
		headers: { Cookie: sessionCookie },
	})
	expect(appOriginResponse.status).toBe(302)
	const handoffLocation = new URL(
		appOriginResponse.headers.get('Location') ?? '',
	)
	expect(handoffLocation.origin).toBe(profileOrigin)
	expect(handoffLocation.pathname).toBe('/demo/x')
	expect([...handoffLocation.searchParams.keys()].sort()).toEqual(
		[packageAppHandoffQueryParam, 'tab'].sort(),
	)

	const handoffResponse = await workerFetch(handoffLocation)
	expect(handoffResponse.status).toBe(302)
	expect(handoffResponse.headers.get('Location')).toBe(
		`${profileOrigin}/demo/x?tab=1`,
	)
	const setCookie =
		handoffResponse.headers
			.getSetCookie()
			.find((cookie) => cookie.startsWith('__Host-kody_pkg_session_')) ?? ''
	expect(setCookie).not.toContain('Domain=')
	const packageSessionCookie = setCookie.split(';')[0] ?? ''

	// With the session every path and method passes the gate and reaches
	// serving for the profile package. Workers-unit D1 seeds no package source,
	// so serving ends in 404 or 500; a redirect or 403 would mean the platform
	// still handled the path itself.
	for (const [path, method] of [
		['/', 'GET'],
		['/demo/x', 'GET'],
		['/packages/demo', 'GET'],
		['/robots.txt', 'GET'],
		['/newsletter/unsubscribe', 'POST'],
	] as const) {
		const served = await workerFetch(`${profileOrigin}${path}`, {
			method,
			headers: { Cookie: packageSessionCookie },
		})
		expect({ path, ok: [404, 500].includes(served.status) }).toEqual({
			path,
			ok: true,
		})
		expect(served.headers.get('Location')).toBeNull()
		expect(served.headers.get('x-kody-default')).toBeNull()
	}

	// `/-/` stays with the platform, and sign-in on this host is always for the
	// profile package, whatever `?app=` says.
	expect((await workerFetch(`${profileOrigin}/-/health`)).status).toBe(200)
	const clientIds = []
	for (const query of ['', '?app=demo']) {
		const login = await workerFetch(
			`${profileOrigin}${packageAppOauthPaths.login}${query}`,
		)
		expect(login.status).toBe(302)
		clientIds.push(
			new URL(login.headers.get('Location') ?? '').searchParams.get(
				'client_id',
			),
		)
	}
	expect(clientIds[0]).toContain(ownerUsername)
	expect(clientIds[0]).not.toContain('demo')
	expect(clientIds[1]).toBe(clientIds[0])

	// The profile app has one origin: its `{slug}--{slug}` host redirects.
	const doubled = await workerFetch(
		`https://${ownerUsername}--${ownerUsername}.packages.isolated.test/a?b=1`,
		{ method: 'POST' },
	)
	expect(doubled.status).toBe(308)
	expect(doubled.headers.get('Location')).toBe(`${profileOrigin}/a?b=1`)

	// Removing the profile package returns the host to its default behavior.
	await deleteProfilePackage()
	const bareAfter = await workerFetch(`${profileOrigin}/`)
	expect(bareAfter.status).toBe(302)
	expect(bareAfter.headers.get('Location')).toBe(`${appOrigin}/`)
})
