import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { ensureOpenLinkTestSchema } from '#worker/app-visit/open-link-test-schema.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { consumePackageAppHandoffToken } from '#app/package-app-handoff.ts'
import {
	consumePackageAppOpenLinkToken,
	createPackageAppOpenLinkToken,
	packageAppOpenLinkSessionTtlMs,
	packageAppOpenLinkTtlMs,
} from '#worker/app-visit/open-link.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import type { AppVisitSessionCredential } from '#worker/app-visit/session-credential.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const cookieSecret = 'PACKAGE_APP_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'
const personId = '1'.repeat(64)

async function createTestEnv(input: { db?: 'missing' } = {}) {
	const db = createD1FromSqlite(new DatabaseSync(':memory:'))
	if (input.db !== 'missing') await ensureOpenLinkTestSchema(db)
	return { COOKIE_SECRET: cookieSecret, APP_DB: db } as unknown as Env
}

const profileCredential: AppVisitSessionCredential = {
	kind: 'api-token',
	id: 'token-1',
	scopes: ['app:execute', 'app:read'],
	profileId: 'prf_research',
	profileChain: ['prf_root', 'prf_research'],
	profileOrgId: ownerIdFromStored('org-visitor'),
}

const claims = {
	stableUserId: personId,
	username: 'acme',
	kodyId: 'board',
	host: 'board--acme.kody.run',
	credential: profileCredential,
}
const expected = { username: 'acme', kodyId: 'board', host: claims.host }

test('an open link is exchanged once, within five minutes, for the credential it was minted with', async () => {
	silenceExpectedConsoleWarns(['Package app open link rejected.'])
	const env = await createTestEnv()
	const now = Date.now()
	const mint = () => createPackageAppOpenLinkToken({ env, claims, now })
	const consume = (
		token: string,
		input: { expected?: typeof expected; now?: number } = {},
	) => consumePackageAppOpenLinkToken({ env, token, expected, now, ...input })

	expect(packageAppOpenLinkTtlMs).toBe(5 * 60_000)
	expect(packageAppOpenLinkSessionTtlMs).toBe(60 * 60_000)
	const { token, expiresAt } = await mint()
	expect(expiresAt).toBe(now + packageAppOpenLinkTtlMs)

	// The profile chain, scopes, and credential come back exactly as minted.
	await expect(consume(token)).resolves.toEqual(claims)
	// Single use: the same link never starts a second session.
	await expect(consume(token)).resolves.toBeNull()

	// Wrong app, org, or host: refused, and not spent on the wrong address.
	const bound = (await mint()).token
	for (const wrong of [
		{ ...expected, kodyId: 'notes' },
		{ ...expected, username: 'globex' },
		{ ...expected, host: 'notes--acme.kody.run' },
		{ ...expected, host: 'evil.example.com' },
	]) {
		await expect(consume(bound, { expected: wrong })).resolves.toBeNull()
	}
	await expect(consume(bound)).resolves.toEqual(claims)

	// Expired, and a link dated further out than a link can be.
	const stale = (await mint()).token
	await expect(
		consume(stale, { now: now + packageAppOpenLinkTtlMs }),
	).resolves.toBeNull()
	await expect(consume(stale, { now: now - 1000 })).resolves.toBeNull()

	// Tampered payload or signature, and malformed tokens.
	const [payload = '', signature = ''] = (await mint()).token.split('.')
	const widened = Buffer.from(
		JSON.stringify({
			...JSON.parse(Buffer.from(payload, 'base64url').toString()),
			cred: { kind: 'session', id: null, scopes: null },
		}),
	).toString('base64url')
	for (const forged of [
		`${widened}.${signature}`,
		`${payload}.${signature.slice(0, -2)}AA`,
		payload,
		`${payload}.${signature}.extra`,
		'',
	]) {
		await expect(consume(forged)).resolves.toBeNull()
	}
})

test('an open link fails closed when it cannot be burned', async () => {
	silenceExpectedConsoleWarns([
		'Package app open link rejected.',
		'Package app open link replay check failed.',
	])
	const env = await createTestEnv({ db: 'missing' })
	const { token } = await createPackageAppOpenLinkToken({ env, claims })
	await expect(
		consumePackageAppOpenLinkToken({ env, token, expected }),
	).resolves.toBeNull()
})

test('concurrent exchanges of one open link have exactly one winner', async () => {
	silenceExpectedConsoleWarns(['Package app open link rejected.'])
	const env = await createTestEnv()
	const { token } = await createPackageAppOpenLinkToken({ env, claims })
	const results = await Promise.all(
		Array.from({ length: 8 }, () =>
			consumePackageAppOpenLinkToken({ env, token, expected }),
		),
	)
	expect(results.filter(Boolean)).toHaveLength(1)
})

test('an open link is not a handoff token and its session is not a Kody account session', async () => {
	silenceExpectedConsoleWarns(['Package app handoff rejected.'])
	const env = await createTestEnv()
	const { token } = await createPackageAppOpenLinkToken({ env, claims })
	await expect(
		consumePackageAppHandoffToken({
			env,
			token,
			expected: { username: 'acme', kodyId: 'board' },
		}),
	).resolves.toBeNull()

	const [setCookie = ''] = await createPackageAppSessionCookie({
		env,
		session: {
			stableUserId: personId,
			username: 'acme',
			credential: profileCredential,
			host: claims.host,
		},
		slug: 'board',
		secure: true,
		expiresAt: Date.now() + packageAppOpenLinkSessionTtlMs,
	})
	// Host-only and app-scoped: `__Host-`, no Domain, an hour at most.
	expect(setCookie).toMatch(/^__Host-kody_pkg_session_[\w-]{12}=/)
	expect(setCookie).toContain('Path=/')
	expect(setCookie).toContain('HttpOnly')
	expect(setCookie).toContain('Secure')
	expect(setCookie).toContain('Max-Age=3600')
	expect(setCookie).not.toMatch(/Domain=/i)

	const cookie = setCookie.split(';')[0] ?? ''
	const request = (name: string) =>
		new Request('https://board--acme.kody.run/', {
			headers: { Cookie: `${name}=${cookie.split('=').slice(1).join('=')}` },
		})
	const cookieName = cookie.split('=')[0] ?? ''
	// The same app reads the credential back; another app on the host does not.
	await expect(
		readPackageAppSession({ request: request(cookieName), env, slug: 'board' }),
	).resolves.toMatchObject({
		session: { stableUserId: personId, credential: profileCredential },
	})
	await expect(
		readPackageAppSession({ request: request(cookieName), env, slug: 'notes' }),
	).resolves.toBeNull()
	// A same-named app on another host does not accept it either.
	await expect(
		readPackageAppSession({
			request: new Request('https://board--other.kody.run/', {
				headers: { Cookie: cookie },
			}),
			env,
			slug: 'board',
		}),
	).resolves.toBeNull()
	// Replayed under the account cookie name, it is not an account session.
	setAuthSessionSecret(cookieSecret)
	await expect(
		readParsedAuthSession(request('__Host-kody_session')),
	).resolves.toBeNull()
	await expect(
		readParsedAuthSession(request('kody_session')),
	).resolves.toBeNull()
})
