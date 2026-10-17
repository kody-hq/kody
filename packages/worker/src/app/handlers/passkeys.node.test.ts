import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { testAccountPasskeysApiHandler } from '#app/handlers/account-passkeys.test-support.ts'
import {
	webauthnAuthenticationOptions,
	webauthnAuthenticationVerify,
	webauthnRegistrationOptions,
} from '#worker/identity/webauthn-operations.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { provisionPersonalOrgForSqliteUser } from '#worker/test-support/personal-org-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import type * as WebauthnServer from '@simplewebauthn/server'
vi.mock('@simplewebauthn/server', async (importOriginal) => ({
	...(await importOriginal<typeof WebauthnServer>()),
	verifyAuthenticationResponse: vi.fn(),
}))

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type Handler = ReturnType<typeof testAccountPasskeysApiHandler>

function setup() {
	setAuthSessionSecret(testCookieSecret)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		APP_BASE_URL: 'http://example.com',
		COOKIE_SECRET: testCookieSecret,
		SENTRY_ENVIRONMENT: 'test',
	} as unknown as Parameters<typeof testAccountPasskeysApiHandler>[0]
	const seedUser = async (id: number, username: string) => {
		const email = `${username}@example.com`
		const stableUserId = testStableUserIdFromEmail(email)
		sqlite
			.prepare(
				`INSERT INTO users (id, username, email, stable_user_id, password_hash, email_verified_at)
				VALUES (?, ?, ?, ?, 'unused', CURRENT_TIMESTAMP)`,
			)
			.run(id, username, email, stableUserId)
		await provisionPersonalOrgForSqliteUser(sqlite, { stableUserId, username })
	}
	const seedPasskey = (input: {
		id: string
		userId: number
		name?: string
		aaguid?: string
		lastUsedAt?: string
	}) => {
		sqlite
			.prepare(
				`INSERT INTO passkeys (
					id, aaguid, public_key, user_id, webauthn_user_handle, counter,
					device_type, backed_up, transports, name, last_used_at
				) VALUES (?, ?, 'cHVibGljLWtleQ', ?, 'd2ViYXV0aG4tdXNlcg', 0,
					'multiDevice', 1, 'internal', ?, ?)`,
			)
			.run(
				input.id,
				input.aaguid ?? '00000000-0000-0000-0000-000000000000',
				input.userId,
				input.name ?? '',
				input.lastUsedAt ?? null,
			)
	}
	return { sqlite, env, seedUser, seedPasskey }
}

function userOneCookie() {
	return createAuthCookie(
		{
			stableUserId: testStableUserIdFromEmail('one@example.com'),
			email: 'one@example.com',
			rememberMe: false,
		},
		false,
	)
}

async function run(
	handler: Handler,
	path: string,
	init: { cookie?: string; body?: unknown } = {},
) {
	const headers: Record<string, string> = {}
	if (init.cookie) headers.Cookie = init.cookie
	if (init.body !== undefined) headers['Content-Type'] = 'application/json'
	const request = new Request(`http://example.com${path}`, {
		headers,
		...(init.body === undefined
			? {}
			: { method: 'POST', body: JSON.stringify(init.body) }),
	})
	return handler.execute({
		request,
		url: new URL(request.url),
		params: {},
	} as never)
}

type PasskeysPayload = {
	ok: boolean
	passkeys: Array<{ id: string; name: string; lastUsedAt: string | null }>
}

test('account passkeys API lists labels/dates, renames owned keys, and deletes while ignoring other users', async () => {
	const { sqlite, env, seedUser, seedPasskey } = setup()
	await seedUser(1, 'one')
	await seedUser(2, 'two')
	seedPasskey({
		id: 'passkey-user-1',
		userId: 1,
		aaguid: 'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4',
		lastUsedAt: '2026-07-01 12:00:00',
	})
	seedPasskey({ id: 'passkey-user-1b', userId: 1, name: 'Work laptop' })
	seedPasskey({ id: 'passkey-user-2', userId: 2, name: 'Other user' })

	const handler = testAccountPasskeysApiHandler(env)
	const cookie = await userOneCookie()
	const post = async (body: Record<string, string>) => {
		const response = await run(handler, '/account/passkeys.json', {
			cookie,
			body,
		})
		return {
			status: response.status,
			payload: response.data as PasskeysPayload,
		}
	}
	const otherUserRow = () =>
		sqlite
			.prepare(`SELECT name FROM passkeys WHERE id = 'passkey-user-2'`)
			.get()

	const list = await run(handler, '/account/passkeys.json', { cookie })
	expect(list.status).toBe(200)
	const listPayload = list.data as PasskeysPayload
	expect(listPayload.ok).toBe(true)
	expect(listPayload.passkeys).toMatchObject([
		{ id: 'passkey-user-1b', name: 'Work laptop', lastUsedAt: null },
		{
			id: 'passkey-user-1',
			name: 'Google Password Manager',
			lastUsedAt: '2026-07-01 12:00:00',
		},
	])

	const crossUserRename = await post({
		intent: 'rename',
		passkeyId: 'passkey-user-2',
		name: 'Stolen name',
	})
	expect(crossUserRename.status).toBe(404)
	expect(otherUserRow()).toEqual({ name: 'Other user' })

	const ownRename = await post({
		intent: 'rename',
		passkeyId: 'passkey-user-1',
		name: '  Phone · Google  ',
	})
	expect(ownRename.status).toBe(200)
	expect(ownRename.payload.ok).toBe(true)
	expect(
		sqlite
			.prepare(`SELECT name FROM passkeys WHERE id = 'passkey-user-1'`)
			.get()?.name,
	).toBe('Phone · Google')

	const blankRename = await post({
		intent: 'rename',
		passkeyId: 'passkey-user-1',
		name: '   ',
	})
	expect(blankRename.status).toBe(400)

	const crossUserDelete = await post({
		intent: 'delete',
		passkeyId: 'passkey-user-2',
	})
	expect(crossUserDelete.status).toBe(404)
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM passkeys`).get(),
	).toEqual({ count: 3 })

	const ownDelete = await post({
		intent: 'delete',
		passkeyId: 'passkey-user-1',
	})
	expect(ownDelete.status).toBe(200)
	expect(ownDelete.payload.ok).toBe(true)
	expect(ownDelete.payload).toEqual({ ok: true })
	expect(
		sqlite
			.prepare(`SELECT id FROM passkeys WHERE user_id = 1 ORDER BY id`)
			.all(),
	).toEqual([{ id: 'passkey-user-1b' }])
})

test('registration options require authentication and exclude existing credentials', async () => {
	const { env, seedUser, seedPasskey } = setup()
	const options = (cookie?: string) =>
		webauthnRegistrationOptions({
			env,
			request: new Request('http://example.com/webauthn/registration', {
				headers: cookie ? { Cookie: cookie } : {},
			}),
			url: new URL('http://example.com/webauthn/registration'),
			body: {},
		})
	expect((await options()).status).toBe(401)

	await seedUser(1, 'one')
	seedPasskey({ id: 'passkey-user-1', userId: 1 })
	const response = await options(await userOneCookie())
	expect(response.status).toBe(200)
	const payload = (await Promise.resolve(response.data)) as {
		ok: boolean
		options: {
			challenge: string
			rp: { id: string }
			excludeCredentials: Array<{ id: string }>
		}
	}
	expect(payload.ok).toBe(true)
	expect(payload.options.rp.id).toBe('example.com')
	expect(payload.options.challenge.length).toBeGreaterThan(0)
	expect(payload.options.excludeCredentials).toEqual([
		expect.objectContaining({ id: 'passkey-user-1' }),
	])
	expect(response.headers.get('Set-Cookie')).toContain(
		'kody_webauthn_challenge=',
	)
})

test('authentication issues challenge options and rejects unknown passkeys', async () => {
	const env = setup().env
	const url = new URL('http://example.com/webauthn/authentication')
	const options = await webauthnAuthenticationOptions({
		env,
		request: new Request(url),
		url,
		body: {},
	})
	expect(options.status).toBe(200)
	const optionsPayload = (await Promise.resolve(options.data)) as {
		ok: boolean
		options: { challenge: string }
	}
	expect(optionsPayload.ok).toBe(true)
	expect(optionsPayload.options.challenge.length).toBeGreaterThan(0)
	const challengeCookie = options.headers.get('Set-Cookie')?.split(';')[0] ?? ''
	expect(challengeCookie).toContain('kody_webauthn_challenge=')

	const response = await webauthnAuthenticationVerify({
		env,
		request: new Request(url, { headers: { Cookie: challengeCookie } }),
		url,
		body: {
			response: { id: 'unknown-passkey', rawId: 'unknown-passkey' } as never,
		},
	})
	expect(response.status).toBe(401)
	expect(await Promise.resolve(response.data)).toMatchObject({ ok: false })
})

test('a cryptographically verified passkey cannot mint a session for a tombstoned person', async () => {
	const { env, sqlite, seedUser, seedPasskey } = setup()
	await seedUser(1, 'deleted-passkey-user')
	seedPasskey({ id: 'deleted-passkey', userId: 1 })
	const url = new URL('http://example.com/webauthn/authentication')
	const options = await webauthnAuthenticationOptions({
		env,
		request: new Request(url),
		url,
		body: {},
	})
	const cookie = options.headers.get('Set-Cookie')!.split(';')[0]!
	sqlite.exec(`UPDATE users SET deleted_at = CURRENT_TIMESTAMP WHERE id = 1`)
	vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
		verified: true,
		authenticationInfo: { newCounter: 1 },
	} as never)
	const result = await webauthnAuthenticationVerify({
		env,
		request: new Request(url, { headers: { Cookie: cookie } }),
		url,
		body: {
			response: { id: 'deleted-passkey', rawId: 'deleted-passkey' } as never,
		},
	})
	expect(verifyAuthenticationResponse).toHaveBeenCalledOnce()
	expect(result.status).toBe(401)
	expect(result.data).toEqual({ ok: false, error: 'Passkey sign-in failed.' })
	expect(
		result.headers
			.getSetCookie()
			.some(
				(cookie) =>
					cookie.startsWith('kody_session=') && !cookie.includes('Max-Age=0'),
			),
	).toBe(false)
	expect(result.headers.get('Set-Cookie')).toContain('kody_webauthn_challenge=')
})
