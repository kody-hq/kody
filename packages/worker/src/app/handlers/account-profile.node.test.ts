import { beforeAll, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	updateCommunityProfile: vi.fn(),
}))

vi.mock('#worker/community/profile-service.ts', () => ({
	updateCommunityProfile: (...args: Array<unknown>) =>
		mocks.updateCommunityProfile(...args),
}))

import { createAuthCookie, setAuthSessionSecret } from '#app/auth-session.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { testAccountProfileApiHandler } from './account-profile.test-support.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

type TestUser = ReturnType<typeof createUser>

function createProfileTestDb(
	initialUsers: Array<TestUser>,
	options?: { persistUsernameUpdates?: boolean },
) {
	const persistUsernameUpdates = options?.persistUsernameUpdates !== false
	const users = new Map(initialUsers.map((user) => [user.id, { ...user }]))
	const db = {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					const updateUsername = () => {
						const [username, updatedAt, id] = params as Array<string | number>
						const user = users.get(Number(id))
						if (!user) return null
						if (
							Array.from(users.values()).some(
								(existingUser) =>
									existingUser.id !== user.id &&
									existingUser.username.toLowerCase() ===
										String(username).toLowerCase(),
							)
						) {
							throw new Error('UNIQUE constraint failed: users.username')
						}
						if (persistUsernameUpdates) {
							user.username = String(username)
						}
						user.updated_at = String(updatedAt)
						return user
					}
					const selectUser = () => {
						const needle = String(params[0] ?? '')
						const matchers: Array<[RegExp, (user: TestUser) => boolean]> = [
							[
								/"stable_user_id"\s*=/,
								(user) => user.stable_user_id === needle,
							],
							[/"id"\s*=/, (user) => user.id === Number(needle)],
							[
								/"username"\s*=/,
								(user) => user.username.toLowerCase() === needle.toLowerCase(),
							],
						]
						const matcher = matchers.find(([pattern]) =>
							pattern.test(normalizedQuery),
						)
						return matcher
							? (Array.from(users.values()).find(matcher[1]) ?? null)
							: null
					}
					const executeAll = async () => {
						if (normalizedQuery.includes('update "users"')) {
							const user = updateUsername()
							return {
								results: user ? [{ ...user }] : [],
								meta: { changes: user ? 1 : 0, last_row_id: 0 },
							}
						}
						const user =
							normalizedQuery.startsWith('select') &&
							normalizedQuery.includes('from "users"')
								? selectUser()
								: null
						return {
							results: user ? [{ ...user }] : [],
							meta: { changes: 0, last_row_id: 0 },
						}
					}

					return {
						query,
						all: executeAll,
						async first() {
							if (isOrgBindingMembershipQuery(normalizedQuery)) {
								const personId = String(params[0] ?? '')
								const user = Array.from(users.values()).find(
									(row) => row.stable_user_id === personId,
								)
								return user
									? mockPersonalOrgBindingRow(
											user.stable_user_id,
											user.username,
										)
									: null
							}
							const result = await executeAll()
							return result.results[0] ?? null
						},
						async run() {
							const user = normalizedQuery.includes('update "users"')
								? updateUsername()
								: null
							return { meta: { changes: user ? 1 : 0, last_row_id: 0 } }
						},
					}
				},
			}
		},
		async batch(statements: Array<{ query?: string }>) {
			return await executePreparedD1Batch(statements)
		},
		async exec() {
			return
		},
	} as unknown as D1Database

	return { db, users }
}

function createUser(id: number, username: string) {
	const email = `${username}@example.com`
	return {
		id,
		email,
		username,
		password_hash: 'unused',
		stable_user_id: testStableUserIdFromEmail(email),
		display_name: null as string | null,
		bio: null as string | null,
		avatar_key: null as string | null,
		profile_visibility: 'public' as 'public' | 'private',
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
}

function createProfileClient(
	usernames: Array<string>,
	options: { persistUsernameUpdates?: boolean; kv?: KVNamespace } = {},
) {
	const testDb = createProfileTestDb(
		usernames.map((username, index) => createUser(index + 1, username)),
		options,
	)
	const env = {
		APP_DB: testDb.db,
		COOKIE_SECRET: testCookieSecret,
		APP_BASE_URL: 'http://example.com',
		...(options.kv ? { BUNDLE_ARTIFACTS_KV: options.kv } : {}),
	} as Env
	const { execute } = testAccountProfileApiHandler(env)
	const email = `${usernames[0]}@example.com`
	const send = async (body?: Record<string, unknown>) => {
		const cookie = await createAuthCookie(
			{
				stableUserId: testStableUserIdFromEmail(email),
				email,
				rememberMe: false,
			},
			false,
		)
		const request = new Request('http://example.com/account/profile.json', {
			method: body ? 'POST' : 'GET',
			headers: {
				Cookie: cookie,
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		})
		return execute({ request, url: new URL(request.url), params: {} } as never)
	}
	return {
		testDb,
		env,
		get: () => send(),
		post: (body: Record<string, unknown>) => send(body),
		username: () => testDb.users.get(1)?.username,
	}
}

function expectAccountAudit(action: string, result: string, extra = {}) {
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({ category: 'account', action, result, ...extra }),
	)
}

beforeAll(() => {
	setAuthSessionSecret(testCookieSecret)
})

test('account profile API returns email and username for the signed-in user', async () => {
	const { get } = createProfileClient(['current-user'])

	const response = await get()

	expect(response.status).toBe(200)
	expect(response.data).toEqual({
		ok: true,
		email: 'current-user@example.com',
		emailVerified: false,
		emailVerificationDelivery: null,
		username: 'current-user',
		displayName: 'current-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})
	// Reads are not audited.
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('account profile API rejects any username change because usernames are permanent', async () => {
	const { post, username } = createProfileClient(['current-user', 'taken-jane'])

	for (const requested of ['Next-Jane', 'taken-jane', 'bad username', 'kody']) {
		const response = await post({ username: requested })
		expect([response.status, response.data]).toEqual([
			400,
			{
				ok: false,
				error:
					'Usernames are permanent and cannot be changed. You can change your display name instead.',
			},
		])
	}
	expect(username()).toBe('current-user')
	expect(mocks.updateCommunityProfile).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()
})

test('account profile API treats an unchanged username as a no-op so grandfathered reserved usernames can still save profile fields', async () => {
	// 'kody' is on the reserved username list; an account that already holds
	// it must still be able to save display name / bio / visibility.
	const { post, username } = createProfileClient(['kody'])
	mocks.updateCommunityProfile.mockResolvedValue(undefined)

	const response = await post({
		username: 'kody',
		displayName: 'Kody the Koala',
		bio: 'Hi',
	})

	expect(response.status).toBe(200)
	expect(response.data).toEqual({ ok: true })
	expect(username()).toBe('kody')
	expect(mocks.updateCommunityProfile).toHaveBeenCalledWith(
		expect.objectContaining({
			numericUserId: 1,
			displayName: 'Kody the Koala',
			bio: 'Hi',
		}),
	)
	expect(logAuditEventSpy).not.toHaveBeenCalledWith(
		expect.objectContaining({ action: 'update_username' }),
	)
})

test('account profile API round trips and validates displayName, bio, and visibility', async () => {
	const { testDb, env, get, post } = createProfileClient(['current-user'])
	const trimmedOrNull = (value: string) => value.trim() || null
	mocks.updateCommunityProfile.mockImplementation(
		async (input: {
			displayName?: string
			bio?: string
			visibility?: 'public' | 'private'
		}) => {
			const user = testDb.users.get(1)
			if (!user) return
			if (input.displayName !== undefined) {
				user.display_name = trimmedOrNull(input.displayName)
			}
			if (input.bio !== undefined) user.bio = trimmedOrNull(input.bio)
			if (input.visibility !== undefined) {
				user.profile_visibility = input.visibility
			}
		},
	)

	const response = await post({
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})

	expect(response.status).toBe(200)
	expect(response.data).toEqual({ ok: true })
	expect(mocks.updateCommunityProfile).toHaveBeenCalledWith({
		env,
		numericUserId: 1,
		displayName: 'Current User',
		bio: 'I build packages',
		visibility: 'private',
	})
	expectAccountAudit('update_profile', 'success')

	expect((await get()).data).toMatchObject({
		displayName: 'Current User',
		bio: 'I build packages',
		profileVisibility: 'private',
	})

	const invalidVisibility = await post({ profileVisibility: 'friends' })
	expect(invalidVisibility.status).toBe(400)
	expect(invalidVisibility.data).toEqual({
		ok: false,
		error: 'Profile visibility is invalid.',
	})

	mocks.updateCommunityProfile.mockRejectedValue(
		new CommunityActionError('Display name must be at most 50 characters.'),
	)
	const invalidDisplayName = await post({ displayName: 'x'.repeat(51) })
	expect(invalidDisplayName.status).toBe(400)
	expect(invalidDisplayName.data).toEqual({
		ok: false,
		error: 'Display name must be at most 50 characters.',
	})
})

test('a committed profile save does not depend on reloading account data', async () => {
	const { env, post } = createProfileClient(['current-user'])
	const prepare = vi.spyOn(env.APP_DB, 'prepare')
	mocks.updateCommunityProfile.mockImplementation(async () => {
		prepare.mockImplementation(() => {
			throw new Error('Post-write account reads are unavailable')
		})
	})
	try {
		const response = await post({ displayName: 'Updated name' })
		expect(response.status).toBe(200)
		expect(response.data).toEqual({ ok: true })
	} finally {
		prepare.mockRestore()
	}
})

test('clearing displayName persists null and acknowledges the committed native save', async () => {
	// Auth resolves once per request with the stored display name. Clearing
	// must not fall back to that cached value in the POST response (Devin on
	// #3879).
	const { testDb, post } = createProfileClient(['ada'])
	const user = testDb.users.get(1)
	expect(user).toBeDefined()
	user!.display_name = 'Ada Lovelace'

	const trimmedOrNull = (value: string) => value.trim() || null
	mocks.updateCommunityProfile.mockImplementation(
		async (input: { displayName?: string }) => {
			const row = testDb.users.get(1)
			if (!row) return
			if (input.displayName !== undefined) {
				row.display_name = trimmedOrNull(input.displayName)
			}
		},
	)

	const response = await post({ displayName: '' })

	expect(response.status).toBe(200)
	expect(response.data).toEqual({ ok: true })
	expect(testDb.users.get(1)?.display_name).toBeNull()
})
