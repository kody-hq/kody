import type { OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { env, exports } from 'cloudflare:workers'
import { beforeEach, expect, test } from 'vitest'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import {
	createPackageAppOpenLinkToken,
	packageAppOpenLinkQueryParam,
} from '#worker/app-visit/open-link.ts'
import { revokeApiToken } from '#worker/api-tokens/service.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import type { AppVisitSessionCredential } from '#worker/app-visit/session-credential.ts'
import {
	silenceExpectedConsoleErrors,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import {
	accessFixture,
	accessFixtureOrigin,
	packageAppAccessAuditRows,
	packageAppSessionCookieFor,
	seedPackageAppAccessFixture,
	type AccessFixturePerson,
} from '#worker/test-support/package-app-access-fixture.ts'
import { ensurePackageAppCustomHostnamesTestSchema } from '#worker/test-support/package-app-custom-hostnames-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

/**
 * Open links on the package-app origin, through the real Worker: the
 * exchange for the host-only visit cookie, and what that cookie may do.
 * The fixture apps have no published source, so a request that clears the
 * gate ends in serve's host-setup 500, exactly like a person's session.
 */

const mutableEnv = env as unknown as Record<string, unknown>
const { orgSlug, privateApp, publicApp } = accessFixture
const privateOrigin = `https://${privateApp.slug}--${orgSlug}.packages.isolated.test`
const publicOrigin = `https://${publicApp.slug}--${orgSlug}.packages.isolated.test`
const unnarrowed: AppVisitSessionCredential = {
	kind: 'mcp-oauth',
	id: null,
	scopes: null,
}

beforeEach(async () => {
	silenceExpectedConsoleErrors([
		'Package app handler failed:',
		'package-app-http-error',
	])
	silenceExpectedConsoleWarns(['Package app open link rejected.'])
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = 'https://packages.isolated.test'
	mutableEnv.SENTRY_ENVIRONMENT = 'production'
	setAuthSessionSecret(env.COOKIE_SECRET)
	await seedPackageAppAccessFixture()
	for (const person of Object.values(accessFixture.people)) {
		invalidatePackageAppOwnerCache({
			stableUserId: testStableUserIdFromEmail(person.email),
		})
	}
})

async function mintLink(input: {
	person: AccessFixturePerson
	credential?: AppVisitSessionCredential
	origin?: string
	slug?: string
	path?: string
	now?: number
}) {
	const url = new URL(input.path ?? '/', input.origin ?? privateOrigin)
	const { token } = await createPackageAppOpenLinkToken({
		env,
		claims: {
			stableUserId: testStableUserIdFromEmail(
				accessFixture.people[input.person].email,
			),
			username: orgSlug,
			kodyId: input.slug ?? privateApp.slug,
			host: url.host,
			credential: input.credential ?? unnarrowed,
		},
		now: input.now,
	})
	url.searchParams.set(packageAppOpenLinkQueryParam, token)
	return url
}

async function open(url: string | URL, cookie?: string) {
	const response = await exports.default.fetch(
		new Request(url, {
			redirect: 'manual',
			headers: cookie ? { Cookie: cookie } : {},
		}),
	)
	const setCookies = response.headers.getSetCookie()
	return {
		status: response.status,
		location: response.headers.get('Location'),
		openLink: response.headers.get('X-Kody-Open-Link'),
		body: await response.text(),
		setCookies,
		session:
			setCookies
				.find((cookie) => cookie.startsWith('__Host-kody_pkg_session_'))
				?.split(';')[0] ?? null,
	}
}

test('an open link signs a fresh browser in to one private app, once, with a host-only cookie', async () => {
	const link = await mintLink({ person: 'member', path: '/cards?tab=2' })

	// A browser with no cookie at all cannot open the private app.
	const anonymous = await open(`${privateOrigin}/cards`)
	expect(anonymous.status).toBe(403)

	const exchanged = await open(link)
	expect(exchanged.status).toBe(302)
	// The token leaves the address; the path and query stay.
	expect(exchanged.location).toBe(`${privateOrigin}/cards?tab=2`)
	const sessionCookie = exchanged.setCookies.find((cookie) =>
		cookie.startsWith('__Host-kody_pkg_session_'),
	)
	expect(sessionCookie).toContain('Secure')
	expect(sessionCookie).toContain('HttpOnly')
	expect(sessionCookie).toContain('Path=/')
	expect(sessionCookie).toContain('Max-Age=3600')
	expect(sessionCookie).not.toMatch(/Domain=/i)
	// No Kody account session, and no access ticket, comes with it.
	expect(
		exchanged.setCookies.some((cookie) =>
			/^(__Host-)?kody_session=/.test(cookie),
		),
	).toBe(false)
	const session = exchanged.session ?? ''

	// The cookie alone carries later navigations: the gate is cleared (the
	// fixture app has no source, so serve answers the way it does for a
	// person's own session), with no second link and no ticket minted.
	const person = await open(
		`${privateOrigin}/cards`,
		await packageAppSessionCookieFor('member'),
	)
	for (const path of ['/cards?tab=2', '/settings']) {
		const visit = await open(`${privateOrigin}${path}`, session)
		expect({ path, status: visit.status }).toEqual({
			path,
			status: person.status,
		})
		expect(visit.status).not.toBe(403)
		expect(
			visit.setCookies.some((cookie) => cookie.includes('kody_pkg_ticket_')),
		).toBe(false)
	}

	// Single use: the same link in another fresh browser is refused.
	const replay = await open(link)
	expect(replay).toMatchObject({ status: 403, openLink: 'rejected' })
	expect(replay.session).toBeNull()
	expect(replay.body).toContain('appOpenLink')

	// The cookie is for this app only: it does not open a sibling app's host.
	const sibling = await open(
		`https://other--${orgSlug}.packages.isolated.test/`,
		session,
	)
	expect(sibling.status).toBe(403)

	expect(
		await packageAppAccessAuditRows('package_app_open_link_exchange'),
	).toEqual([
		expect.objectContaining({
			result: 'success',
			path: '/cards',
			reason: `${orgSlug}/${privateApp.slug}: mcp-oauth credential`,
		}),
	])
})

test('an open link is refused when expired, tampered, or opened for another app or host', async () => {
	const refused = async (url: URL) => {
		const result = await open(url)
		expect(result).toMatchObject({ status: 403, openLink: 'rejected' })
		expect(result.setCookies).toEqual([])
	}
	// Minted more than five minutes ago.
	await refused(
		await mintLink({ person: 'member', now: Date.now() - 5 * 60_000 - 1 }),
	)
	// Minted for the private app, opened on the public app's host.
	const wrongHost = await mintLink({ person: 'member' })
	const moved = new URL(wrongHost)
	moved.host = new URL(publicOrigin).host
	await refused(moved)
	// A refused link is terminal even where anonymous visitors are served,
	// so an agent never mistakes an anonymous page for a signed-in one.
	await refused(
		await mintLink({ person: 'member', origin: publicOrigin, slug: 'demo' }),
	)
	// The first link was never spent on the wrong host, so it still works once.
	await expect(open(wrongHost)).resolves.toMatchObject({ status: 302 })

	const tampered = await mintLink({ person: 'member' })
	tampered.searchParams.set(
		packageAppOpenLinkQueryParam,
		`${tampered.searchParams.get(packageAppOpenLinkQueryParam)}x`,
	)
	await refused(tampered)
	const empty = new URL(privateOrigin)
	empty.searchParams.set(packageAppOpenLinkQueryParam, '')
	await refused(empty)
	// A link is a navigation: a POST never exchanges (or spends) one.
	const posted = await mintLink({ person: 'member' })
	const post = await exports.default.fetch(
		new Request(posted, { method: 'POST', redirect: 'manual' }),
	)
	expect(post.status).toBe(403)
	await post.arrayBuffer()
	await expect(open(posted)).resolves.toMatchObject({ status: 302 })
})

test('the visit keeps the scopes of the credential that minted the link', async () => {
	const scoped = (scopes: Array<OrgPermission>): AppVisitSessionCredential => ({
		kind: 'mcp-oauth',
		id: null,
		scopes,
	})
	// A token that cannot run apps mints no session, whatever the person can do.
	const narrow = await open(
		await mintLink({ person: 'owner', credential: scoped(['package:read']) }),
	)
	expect(narrow).toMatchObject({ status: 403, openLink: 'rejected' })
	expect(narrow.session).toBeNull()
	expect(
		await packageAppAccessAuditRows('package_app_access_denied'),
	).toContainEqual(
		expect.objectContaining({
			reason: `${orgSlug}/${privateApp.slug}: open link: no app:execute`,
		}),
	)

	// A token scoped to running apps opens it, and stays that narrow: every
	// request is checked live with those scopes, never from a cached ticket.
	const allowed = await open(
		await mintLink({ person: 'owner', credential: scoped(['app:execute']) }),
	)
	expect(allowed.status).toBe(302)
	const visit = await open(`${privateOrigin}/`, allowed.session ?? '')
	expect(visit.status).not.toBe(403)
	expect(
		visit.setCookies.some((cookie) => cookie.includes('kody_pkg_ticket_')),
	).toBe(false)

	// Someone with no access to the app gets nothing from a link either.
	await env.APP_DB.prepare(
		`DELETE FROM grants WHERE id = 'grant-cost-member'`,
	).run()
	await env.APP_DB.prepare(
		`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`,
	)
		.bind(accessFixture.orgId)
		.run()
	const revoked = await open(await mintLink({ person: 'member' }))
	expect(revoked).toMatchObject({ status: 403, openLink: 'rejected' })
})

test('revoking the API token ends the visit its link opened', async () => {
	const userId = testStableUserIdFromEmail(accessFixture.people.owner.email)
	const token = { id: 'open-link-agent-token' }
	await env.APP_DB.prepare(
		`CREATE TABLE IF NOT EXISTS api_tokens (
			id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, org_id TEXT NOT NULL,
			org_binding TEXT NOT NULL DEFAULT 'org', name TEXT NOT NULL,
			token_hash TEXT NOT NULL, scopes_json TEXT NOT NULL,
			idle_ttl_seconds INTEGER NOT NULL, expires_at TEXT NOT NULL,
			max_expires_at TEXT NOT NULL, created_via TEXT NOT NULL,
			created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT,
			rotated_at TEXT, revoked_at TEXT, profile_id TEXT, deleted_at TEXT
		)`,
	).run()
	const nowIso = new Date().toISOString()
	const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO api_tokens (
			id, user_id, org_id, name, token_hash, scopes_json, idle_ttl_seconds,
			expires_at, max_expires_at, created_via, created_at, updated_at
		) VALUES (?, ?, ?, 'open-link-agent', 'hash', '["app:execute"]', 3600, ?, ?, 'api', ?, ?)`,
	)
		.bind(token.id, userId, userId, expiresAt, expiresAt, nowIso, nowIso)
		.run()
	const opened = await open(
		await mintLink({
			person: 'owner',
			credential: { kind: 'api-token', id: token.id, scopes: ['app:execute'] },
		}),
	)
	expect(opened.status).toBe(302)
	const cookie = opened.session ?? ''
	const live = await open(`${privateOrigin}/`, cookie)
	expect(live.openLink).toBeNull()
	expect(live.status).toBe(500)

	await revokeApiToken({ db: env.APP_DB, userId, tokenId: token.id })

	// The session is gone for the page and for Sign in with Kody's `/me`.
	const visit = await open(`${privateOrigin}/`, cookie)
	expect(visit.status).not.toBe(500)
	const me = await open(`${privateOrigin}/-/auth/me`, cookie)
	expect(me.status).toBe(401)
})

test('a refused agent credential never falls back to the person on a public app', async () => {
	const bumpEpoch = () =>
		env.APP_DB.prepare(
			`UPDATE orgs SET access_epoch = access_epoch + 1 WHERE id = ?`,
		)
			.bind(accessFixture.orgId)
			.run()
	// Decisions are cached per access epoch; an earlier test removed this grant.
	await bumpEpoch()
	const opened = await open(
		await mintLink({
			person: 'member',
			origin: publicOrigin,
			slug: publicApp.slug,
		}),
	)
	expect(opened.status).toBe(302)
	const cookie = opened.session ?? ''

	await env.APP_DB.prepare(
		`DELETE FROM grants WHERE id = 'grant-cost-member'`,
	).run()
	await bumpEpoch()

	// Not the anonymous serve, and not the person's sign-in identity.
	const visit = await open(`${publicOrigin}/`, cookie)
	expect(visit).toMatchObject({ status: 403, openLink: 'rejected' })
})

const mountBase = `${accessFixtureOrigin}/${privateApp.slug}`
const orgHostname = 'apps.open-link-test.example'
const orgMountBase = `https://${orgHostname}/${privateApp.slug}`
const customHostname = 'cards.open-link-test.example'
const customOrigin = `https://${customHostname}`

async function seedCustomHostname() {
	await ensurePackageAppCustomHostnamesTestSchema()
	const now = '2026-11-27T00:00:00.000Z'
	await env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE hostname = ?`,
	)
		.bind(customHostname)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO package_app_custom_hostnames (
			id, hostname, binding_kind, package_id, org_id,
			hostname_status, ssl_status, verified_at, created_at, updated_at
		) VALUES (?, ?, 'app', ?, NULL, 'active', 'active', ?, ?, ?)`,
	)
		.bind(`host-${privateApp.id}`, customHostname, privateApp.id, now, now, now)
		.run()
	await env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE hostname = ?`,
	)
		.bind(orgHostname)
		.run()
	await env.APP_DB.prepare(
		`INSERT INTO package_app_custom_hostnames (
			id, hostname, binding_kind, package_id, org_id,
			hostname_status, ssl_status, verified_at, created_at, updated_at
		) VALUES (?, ?, 'org', NULL, ?, 'active', 'active', ?, ?, ?)`,
	)
		.bind(
			`host-org-${orgSlug}`,
			orgHostname,
			accessFixture.orgId,
			now,
			now,
			now,
		)
		.run()
}

/** What a person's own session gets on the same URL: the gate is cleared. */
async function expectServedLikeAPerson(url: string, session: string) {
	const person = await open(url, await packageAppSessionCookieFor('owner'))
	const visit = await open(url, session)
	expect({ url, status: visit.status }).toEqual({ url, status: person.status })
	expect(visit.status).not.toBe(403)
}

test.each([
	{ name: "the owner's shared host", base: mountBase },
	{ name: "an org's verified custom domain", base: orgMountBase },
])(
	'an open link works on a path mount on $name, and its cookie stays on that host',
	async ({ base }) => {
		await seedCustomHostname()
		const mountOrigin = new URL(base).origin
		const anonymous = await open(`${base}/cards`)
		expect(anonymous.session).toBeNull()
		expect(anonymous.status).not.toBe(200)

		const link = await mintLink({
			person: 'owner',
			origin: mountOrigin,
			path: `/${privateApp.slug}/cards?tab=2`,
		})
		const exchanged = await open(link)
		expect(exchanged.status).toBe(302)
		expect(exchanged.location).toBe(`${base}/cards?tab=2`)
		const sessionCookie = exchanged.setCookies.find((cookie) =>
			cookie.startsWith('__Host-kody_pkg_session_'),
		)
		expect(sessionCookie).toContain('Path=/')
		expect(sessionCookie).not.toMatch(/Domain=/i)
		const session = exchanged.session ?? ''
		expect(session).not.toBe('')

		// Later navigations inside the mount need no second link.
		await expectServedLikeAPerson(`${base}/cards?tab=2`, session)
		await expectServedLikeAPerson(`${base}/settings`, session)

		// The visit is for the mount's host: the same app on its own subdomain
		// does not accept the cookie.
		const onSubdomain = await open(`${privateOrigin}/cards`, session)
		expect(onSubdomain.status).toBe(403)

		await expect(open(link)).resolves.toMatchObject({
			status: 403,
			openLink: 'rejected',
		})
	},
)

test('an open link works on a verified custom domain, and its cookie stays on that host', async () => {
	await seedCustomHostname()
	const anonymous = await open(`${customOrigin}/cards`)
	expect(anonymous.session).toBeNull()
	expect(anonymous.status).not.toBe(200)

	const link = await mintLink({
		person: 'owner',
		origin: customOrigin,
		path: '/cards?tab=2',
	})
	const exchanged = await open(link)
	expect(exchanged.status).toBe(302)
	expect(exchanged.location).toBe(`${customOrigin}/cards?tab=2`)
	const sessionCookie = exchanged.setCookies.find((cookie) =>
		cookie.startsWith('__Host-kody_pkg_session_'),
	)
	expect(sessionCookie).toContain('Path=/')
	expect(sessionCookie).not.toMatch(/Domain=/i)
	const session = exchanged.session ?? ''
	expect(session).not.toBe('')

	await expectServedLikeAPerson(`${customOrigin}/cards?tab=2`, session)
	await expectServedLikeAPerson(`${customOrigin}/settings`, session)

	const onSubdomain = await open(`${privateOrigin}/cards`, session)
	expect(onSubdomain.status).toBe(403)
	const onMount = await open(`${mountBase}/cards`, session)
	expect(onMount.session).toBeNull()
	expect(onMount.status).not.toBe(200)
	expect(onMount.status).not.toBe(500)
})

test('a link minted for one host form of an app is refused on every other', async () => {
	await seedCustomHostname()
	const forms = [
		{ name: 'subdomain', origin: privateOrigin, prefix: '' },
		{
			name: 'path mount',
			origin: accessFixtureOrigin,
			prefix: `/${privateApp.slug}`,
		},
		{ name: 'custom domain', origin: customOrigin, prefix: '' },
		{
			name: 'path mount on an org custom domain',
			origin: `https://${orgHostname}`,
			prefix: `/${privateApp.slug}`,
		},
	]
	expect(new Set(forms.map((form) => new URL(form.origin).host)).size).toBe(4)
	for (const minted of forms) {
		const link = await mintLink({
			person: 'owner',
			origin: minted.origin,
			path: `${minted.prefix}/cards`,
		})
		const token = link.searchParams.get(packageAppOpenLinkQueryParam) ?? ''
		for (const other of forms) {
			if (other === minted) continue
			const moved = new URL(`${other.prefix}/cards`, other.origin)
			moved.searchParams.set(packageAppOpenLinkQueryParam, token)
			const result = await open(moved)
			expect({
				minted: minted.name,
				openedOn: other.name,
				status: result.status,
				openLink: result.openLink,
				setCookies: result.setCookies,
			}).toEqual({
				minted: minted.name,
				openedOn: other.name,
				status: 403,
				openLink: 'rejected',
				setCookies: [],
			})
		}
		// A refusal on the wrong host does not spend the link on its own host.
		await expect(open(link)).resolves.toMatchObject({ status: 302 })
	}
})
