import { env, exports } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
	resetPackageAppSessionCookieForTests,
} from '#app/package-app-session.ts'
import {
	packageAppOauthLegacyPaths,
	packageAppOauthPaths,
} from '#universal/package-app-oauth-paths.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const packageAppOrigin = 'https://packages.isolated.test'
const ownerUsername = 'pkglogout'
const ownerPackageAppOrigin = `https://${ownerUsername}.packages.isolated.test`
const stableUserId = testStableUserIdFromEmail('pkg-logout-owner@example.com')

function configureOrigins() {
	const mutableEnv = env as unknown as Record<string, string | undefined>
	mutableEnv.APP_BASE_URL = 'https://app.kody.test:8788'
	mutableEnv.PACKAGE_APP_BASE_URL = packageAppOrigin
	mutableEnv.SENTRY_ENVIRONMENT = 'test'
}

async function workerFetch(url: string | URL, init: RequestInit = {}) {
	return await exports.default.fetch(
		new Request(url, { redirect: 'manual', ...init }),
	)
}

function remainingCookiesAfterLogout(
	cookieHeader: string,
	logout: Response,
): string {
	const clearedNames = new Set(
		logout.headers
			.getSetCookie()
			.map((header) => header.split('=')[0]?.trim())
			.filter(Boolean),
	)
	return cookieHeader
		.split(';')
		.map((part) => part.trim())
		.filter((part) => {
			const name = part.split('=')[0]
			return name && !clearedNames.has(name)
		})
		.join('; ')
}

test('shared-host logout clears only the requesting app session', async () => {
	resetPackageAppSessionCookieForTests()
	configureOrigins()

	const expiresAt = Date.now() + 60 * 60 * 1000
	const session = { stableUserId, username: ownerUsername }
	const cookiesA = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'notes',
		secure: true,
		expiresAt,
	})
	const cookiesB = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'worlds',
		secure: true,
		expiresAt,
	})
	const pairA = cookiesA[0]?.split(';')[0] ?? ''
	const pairB = cookiesB[0]?.split(';')[0] ?? ''
	const cookieHeader = `${pairA}; ${pairB}`

	const logout = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?app=notes&return_to=${encodeURIComponent('/packages/notes')}`,
		{
			headers: {
				Cookie: cookieHeader,
				Referer: `${ownerPackageAppOrigin}/packages/notes/home`,
			},
		},
	)
	expect(logout.status).toBe(302)
	expect(logout.headers.get('Location')).toBe('/packages/notes')
	const cleared = logout.headers.getSetCookie()
	const clearedNames = new Set(
		cleared.map((header) => header.split('=')[0]?.trim()).filter(Boolean),
	)
	expect(clearedNames.has(pairA.split('=')[0] ?? '')).toBe(true)
	expect(clearedNames.has(pairB.split('=')[0] ?? '')).toBe(false)

	const remaining = remainingCookiesAfterLogout(cookieHeader, logout)
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/notes`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'notes',
		}),
	).resolves.toBeNull()
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/worlds`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'worlds',
		}),
	).resolves.toMatchObject({ session })
})

test('shared-host logout prefers Referer leaf over a sibling ?app=', async () => {
	resetPackageAppSessionCookieForTests()
	configureOrigins()
	const expiresAt = Date.now() + 60 * 60 * 1000
	const session = { stableUserId, username: ownerUsername }
	const cookiesA = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'notes',
		secure: true,
		expiresAt,
	})
	const cookiesB = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'worlds',
		secure: true,
		expiresAt,
	})
	const pairA = cookiesA[0]?.split(';')[0] ?? ''
	const pairB = cookiesB[0]?.split(';')[0] ?? ''
	const cookieHeader = `${pairA}; ${pairB}`

	// Sibling "notes" navigates to logout?app=worlds — Referer wins.
	const logout = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?app=worlds&return_to=/`,
		{
			headers: {
				Cookie: cookieHeader,
				Referer: `${ownerPackageAppOrigin}/notes/settings`,
			},
		},
	)
	expect(logout.status).toBe(302)
	const remaining = remainingCookiesAfterLogout(cookieHeader, logout)
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/notes`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'notes',
		}),
	).resolves.toBeNull()
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/worlds`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'worlds',
		}),
	).resolves.toMatchObject({ session })
})

test('shared-host logout without Referer clears legacy only (not ?app=)', async () => {
	resetPackageAppSessionCookieForTests()
	configureOrigins()
	const expiresAt = Date.now() + 60 * 60 * 1000
	const cookies = await createPackageAppSessionCookie({
		env,
		session: { stableUserId, username: ownerUsername },
		slug: 'notes',
		secure: true,
		expiresAt,
	})
	const pair = cookies[0]?.split(';')[0] ?? ''
	const response = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?app=notes&return_to=/`,
		{ headers: { Cookie: pair } },
	)
	expect(response.status).toBe(302)
	expect(response.headers.get('Location')).toBe('/')
	const cleared = response.headers.getSetCookie()
	expect(
		cleared.some((header) => header.startsWith('__Host-kody_pkg_session=')),
	).toBe(true)
	expect(
		cleared.some((header) => header.startsWith(`${pair.split('=')[0]}=`)),
	).toBe(false)
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/notes`, {
				headers: { Cookie: pair },
			}),
			env,
			slug: 'notes',
		}),
	).resolves.toMatchObject({
		session: { stableUserId, username: ownerUsername },
	})
})

test('older kit return_to=/ still clears the app when Referer has the leaf', async () => {
	resetPackageAppSessionCookieForTests()
	configureOrigins()
	const expiresAt = Date.now() + 60 * 60 * 1000
	const cookies = await createPackageAppSessionCookie({
		env,
		session: { stableUserId, username: ownerUsername },
		slug: 'notes',
		secure: true,
		expiresAt,
	})
	const pair = cookies[0]?.split(';')[0] ?? ''
	const logout = await workerFetch(
		`${ownerPackageAppOrigin}${packageAppOauthPaths.logout}?return_to=/`,
		{
			headers: {
				Cookie: pair,
				Referer: `${ownerPackageAppOrigin}/packages/notes`,
			},
		},
	)
	expect(logout.status).toBe(302)
	const remaining = remainingCookiesAfterLogout(pair, logout)
	await expect(
		readPackageAppSession({
			request: new Request(`${ownerPackageAppOrigin}/packages/notes`, {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'notes',
		}),
	).resolves.toBeNull()
})

test('canonical /-/auth and legacy /_kody/auth both dispatch without redirecting', async () => {
	configureOrigins()
	for (const path of [packageAppOauthPaths.me, packageAppOauthLegacyPaths.me]) {
		const response = await workerFetch(`${ownerPackageAppOrigin}${path}`)
		expect({ path, status: response.status }).toEqual({ path, status: 400 })
		expect(response.headers.get('Location')).toBeNull()
	}
	const unknown = await workerFetch(`${ownerPackageAppOrigin}/-/auth/nope`)
	expect(unknown.status).toBe(404)
	const legacyUnknown = await workerFetch(
		`${ownerPackageAppOrigin}/_kody/auth/nope`,
	)
	expect(legacyUnknown.status).toBe(404)
})
