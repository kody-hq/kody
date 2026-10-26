import { createCookie } from 'remix/cookie'
import { expect, test } from 'vitest'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import {
	createPackageAppSessionCookie,
	destroyPackageAppSessionCookie,
	readPackageAppSession,
	resetPackageAppSessionCookieForTests,
} from '#app/package-app-session.ts'

const cookieSecret = 'package-app-session-node-test-secret'
const stableUserId = testStableUserIdFromEmail('session-owner@example.com')

function createTestEnv(): Env {
	return { COOKIE_SECRET: cookieSecret } as Env
}

test('ignores unrelated cookies without requiring the package-app cookie secret', async () => {
	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kody.run/packages/notes', {
				headers: { Cookie: 'kody_session=account-session; theme=dark' },
			}),
			env: {} as Env,
			slug: 'notes',
		}),
	).resolves.toBeNull()
})

test('per-app sessions on one host: logout of A leaves B signed in', async () => {
	resetPackageAppSessionCookieForTests()
	const env = createTestEnv()
	const now = 1_700_000_000_000
	const expiresAt = now + 60 * 60 * 1000
	const session = { stableUserId, username: 'owner' }

	const cookiesA = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'notes',
		secure: true,
		expiresAt,
		now,
	})
	const cookiesB = await createPackageAppSessionCookie({
		env,
		session,
		slug: 'worlds',
		secure: true,
		expiresAt,
		now: now + 1,
	})
	const pairA = cookiesA[0]?.split(';')[0] ?? ''
	const pairB = cookiesB[0]?.split(';')[0] ?? ''
	expect(pairA).toMatch(/^__Host-kody_pkg_session_[\w-]+=/)
	expect(pairB).toMatch(/^__Host-kody_pkg_session_[\w-]+=/)
	expect(pairA.split('=')[0]).not.toBe(pairB.split('=')[0])

	const both = `${pairA}; ${pairB}`
	const requestBoth = new Request('https://owner.kody.run/packages/notes', {
		headers: { Cookie: both },
	})
	await expect(
		readPackageAppSession({
			request: requestBoth,
			env,
			slug: 'notes',
			now,
		}),
	).resolves.toMatchObject({ session })
	await expect(
		readPackageAppSession({
			request: requestBoth,
			env,
			slug: 'worlds',
			now,
		}),
	).resolves.toMatchObject({ session })

	const clearedA = await destroyPackageAppSessionCookie({
		env,
		slug: 'notes',
		secure: true,
	})
	expect(
		clearedA.some((header) => header.startsWith(`${pairA.split('=')[0]}=`)),
	).toBe(true)
	// Simulate the browser dropping expired cookies named in Set-Cookie.
	const clearedNames = new Set(
		clearedA.map((header) => header.split('=')[0]?.trim()).filter(Boolean),
	)
	const remaining = both
		.split(';')
		.map((part) => part.trim())
		.filter((part) => {
			const name = part.split('=')[0]
			return name && !clearedNames.has(name)
		})
		.join('; ')

	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kody.run/packages/notes', {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'notes',
			now,
		}),
	).resolves.toBeNull()
	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kody.run/packages/worlds', {
				headers: { Cookie: remaining },
			}),
			env,
			slug: 'worlds',
			now,
		}),
	).resolves.toMatchObject({ session })
})

test('destroying a per-app session also clears the legacy host-wide cookie', async () => {
	resetPackageAppSessionCookieForTests()
	const env = createTestEnv()
	const now = 1_700_000_000_000
	const legacyCookie = createCookie('__Host-kody_pkg_session', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		secure: true,
		secrets: [
			await sha256Base64Url(`kody-package-app-session:v2:${cookieSecret}`),
		],
	})
	const legacyPair =
		(
			await legacyCookie.serialize(
				JSON.stringify({
					v: 2,
					stableUserId,
					pkgUsername: 'owner',
					issuedAt: now,
					expiresAt: now + 60 * 60 * 1000,
				}),
			)
		).split(';')[0] ?? ''

	await expect(
		readPackageAppSession({
			request: new Request('https://owner.kody.run/packages/notes', {
				headers: { Cookie: legacyPair },
			}),
			env,
			slug: 'notes',
			now,
		}),
	).resolves.toMatchObject({
		session: { stableUserId, username: 'owner' },
	})

	const cleared = await destroyPackageAppSessionCookie({
		env,
		slug: 'notes',
		secure: true,
	})
	expect(
		cleared.some((header) => header.startsWith('__Host-kody_pkg_session=')),
	).toBe(true)
})
