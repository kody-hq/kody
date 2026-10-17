import { expect, test } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from './auth-session.ts'
import {
	readAuthenticatedAppUser,
	readAuthenticatedAppUserForDeletion,
} from './authenticated-user.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import {
	hasResolvedRequestFeatureFlags,
	loadRequestFeatureFlags,
} from '#app/request-feature-flags-cache.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

const testCookieSecret = 'LOCAL_TEST_COOKIE_SECRET_32_CHARS_MINIMUM'
const email = 'user@example.com'
const stableUserId = testStableUserIdFromEmail(email)

async function sessionRequest(url: string, sessionStableUserId = stableUserId) {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(
		{
			stableUserId: sessionStableUserId,
			email,
			rememberMe: false,
		} satisfies AuthSession,
		false,
	)
	return new Request(url, { headers: { Cookie: cookie } })
}

/** D1 stub that returns `user` for the users lookup and nothing else. */
function createUsersDb(
	options: {
		user?: Record<string, unknown>
		rolesError?: boolean
		missingPersonalOrgBinding?: boolean
		counts?: { batch: number; flagPrepares: number }
	} = {},
) {
	const {
		user,
		rolesError = false,
		missingPersonalOrgBinding = false,
		counts,
	} = options
	const env = {
		APP_DB: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				if (
					counts &&
					(normalized.includes('from feature_flags') ||
						normalized.includes('from feature_flag_user_overrides'))
				) {
					counts.flagPrepares += 1
				}
				const statement = {
					query,
					bind: () => statement,
					first: async () => {
						if (
							(normalized.includes('from org_memberships') ||
								normalized.includes('join org_memberships')) &&
							normalized.includes('join orgs')
						) {
							if (missingPersonalOrgBinding) return null
							const slug =
								typeof user?.username === 'string' ? user.username : 'html-user'
							return {
								org_id: stableUserId,
								org_slug: slug,
								role: 'owner',
							}
						}
						return null
					},
					run: async () => ({ meta: { changes: 0 } }),
					async all() {
						if (rolesError && normalized.includes('from user_roles')) {
							throw new Error('D1 unavailable')
						}
						if (user && normalized.includes('from "users"')) {
							return {
								results: [
									{ id: 7, email, stable_user_id: stableUserId, ...user },
								],
								meta: { changes: 0 },
							}
						}
						return { results: [], meta: { changes: 0 } }
					},
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				if (counts) counts.batch += 1
				return await executePreparedD1Batch(statements)
			},
			async exec() {},
		} as unknown as D1Database,
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
	}
	return env as unknown as Env
}

test('readAuthenticatedAppUser returns null without a cookie or for unknown stable user ids', async () => {
	expect(
		await readAuthenticatedAppUser(
			new Request('https://example.com/account/secrets.json'),
			{ COOKIE_SECRET: testCookieSecret } as Env,
		),
	).toBeNull()

	expect(
		await readAuthenticatedAppUser(
			await sessionRequest(
				'https://example.com/account/profile.json',
				'f'.repeat(64),
			),
			createUsersDb(),
		),
	).toBeNull()
})

test('readAuthenticatedAppUser fails closed to empty roles when the rbac query errors', async () => {
	consoleError.mockImplementation(() => {})
	const user = await readAuthenticatedAppUser(
		await sessionRequest('https://example.com/session'),
		createUsersDb({
			user: { username: 'resilient-user', password_hash: 'irrelevant' },
			rolesError: true,
		}),
	)
	expect(user).toMatchObject({
		username: 'resilient-user',
		roles: [],
		permissions: [],
	})
	expect(consoleError).toHaveBeenCalled()
})

test('deleting accounts are invalid for normal requests but can retry deletion', async () => {
	const env = createUsersDb({
		user: { username: 'deleting-user', deleting_at: '2026-07-22 22:00:00' },
	})
	const url = 'https://example.com/account/delete'
	await expect(
		readAuthenticatedAppUser(await sessionRequest(url), env),
	).resolves.toBeNull()
	await expect(
		readAuthenticatedAppUserForDeletion(await sessionRequest(url), env),
	).resolves.toEqual(
		expect.objectContaining({ userId: 7, username: 'deleting-user' }),
	)
})

test('soft-deleted accounts are invalid even for deletion retry', async () => {
	const env = createUsersDb({
		user: {
			username: 'soft-deleted-user',
			deleted_at: '2026-10-16T22:23:07.000Z',
		},
	})
	const url = 'https://example.com/@soft-deleted-user/-/billing.json'
	await expect(
		readAuthenticatedAppUser(await sessionRequest(url), env),
	).resolves.toBeNull()
	await expect(
		readAuthenticatedAppUserForDeletion(await sessionRequest(url), env),
	).resolves.toBeNull()
})

test('missing personal-org membership fails closed as signed out instead of 500', async () => {
	const env = createUsersDb({
		user: { username: 'orphan-user' },
		missingPersonalOrgBinding: true,
	})
	const request = await sessionRequest(
		'https://example.com/account/organizations.json',
	)
	await expect(readAuthenticatedAppUser(request, env)).resolves.toBeNull()
	// Same-request SSR/login must see signed-out + destroy-cookie so a live
	// person with no personal-org membership cannot redirect-loop on /login.
	const resolved = await loadResolvedRequestAuth(request, env)
	expect(resolved.user).toBeNull()
	expect(resolved.setCookie ?? '').toContain('kody_session=')
	expect(resolved.setCookie ?? '').toContain('Max-Age=0')
})

test('missing personal-org membership fails closed even when a team org is bound', async () => {
	const env = createUsersDb({
		user: { username: 'team-orphan' },
		missingPersonalOrgBinding: true,
	})
	// Org-binding middleware would set a team slug; resolution that is not
	// personal/denied must still require a live personal-org membership.
	const request = await sessionRequest(
		'https://example.com/@acme/-/billing.json',
	)
	await expect(readAuthenticatedAppUser(request, env)).resolves.toBeNull()
})

test('readAuthenticatedAppUser prefetches flags only when HTML pages opt in', async () => {
	const counts = { batch: 0, flagPrepares: 0 }
	const env = createUsersDb({ user: { username: 'html-user' }, counts })

	const apiRequest = await sessionRequest('https://example.com/account/agents')
	const apiUser = await readAuthenticatedAppUser(apiRequest, env)
	expect(apiUser?.username).toBe('html-user')
	expect(hasResolvedRequestFeatureFlags(apiRequest)).toBe(false)
	// API-style: user+roles only. No Accept/path heuristic can start flags.
	expect(counts).toEqual({ batch: 1, flagPrepares: 0 })

	const htmlRequest = await sessionRequest('https://example.com/')
	const htmlUser = await readAuthenticatedAppUser(htmlRequest, env, {
		prefetchFeatureFlags: true,
	})
	if (!htmlUser) throw new Error('expected authenticated html user')
	expect(htmlUser.username).toBe('html-user')
	expect(hasResolvedRequestFeatureFlags(htmlRequest)).toBe(true)
	// HTML opt-in adds one user+roles batch and one flags batch (total 3).
	expect(counts).toEqual({ batch: 3, flagPrepares: 2 })

	await loadRequestFeatureFlags(htmlRequest, env, {
		userId: htmlUser.userId,
		stableUserId: htmlUser.mcpUser.userId,
	})
	expect(counts).toEqual({ batch: 3, flagPrepares: 2 })
})

test('resource binding reuses original RPC authentication without trusting resource cookies', async () => {
	const counts = { batch: 0, flagPrepares: 0 }
	const env = createUsersDb({ user: { username: 'html-user' }, counts })
	const original = await sessionRequest('https://example.com/_serverFn/read')
	const first = await readAuthenticatedAppUser(original, env)
	// The synthetic resource URL has no credentials. Identity comes only from
	// the original HTTP request, and shares its existing request-scoped lookup.
	const resourceRequest = new Request('https://example.com/account/memories')
	const second = await readAuthenticatedAppUser(original, env, {
		resourceRequest,
	})
	expect(second?.mcpUser.userId).toBe(first?.mcpUser.userId)
	expect(second).not.toBeNull()
	expect(counts.batch).toBe(1)
	// Supplying an authenticated resource request cannot authenticate an anonymous RPC.
	expect(
		await readAuthenticatedAppUser(
			new Request('https://example.com/_serverFn/read'),
			env,
			{
				resourceRequest: original,
			},
		),
	).toBeNull()
})
