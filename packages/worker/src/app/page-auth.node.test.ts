import { expect, test } from 'vitest'
import { createAuthCookie, setAuthSessionSecret } from './auth-session.ts'
import { requireAuthenticatedPageUser } from './page-auth.ts'
import { loadResolvedRequestAuth } from './request-auth-cache.ts'
import {
	hasResolvedRequestFeatureFlags,
	loadRequestFeatureFlags,
} from './request-feature-flags-cache.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

import { isOrgBindingMembershipQuery } from '#worker/test-support/org-binding-query.ts'

const secret = 'test-cookie-secret-0123456789abcdef0123456789'
const stableUserId = 'f'.repeat(64)
const personalOrgId = 'a'.repeat(64)

function authFixture() {
	const state = {
		user: {
			id: 7,
			email: 'page-auth@example.com',
			username: 'page-user',
			stable_user_id: stableUserId,
			personal_org_id: personalOrgId,
		} as Record<string, unknown> | null,
		authBatches: 0,
	}
	const env = {
		COOKIE_SECRET: secret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: {
			prepare(query: string) {
				const statement = {
					query,
					bind: () => statement,
					first: async () =>
						isOrgBindingMembershipQuery(query.toLowerCase()) && state.user
							? { org_id: personalOrgId, org_slug: 'page-user', role: 'owner' }
							: null,
					run: async () => ({ meta: { changes: 0 } }),
					all: async () => ({
						results:
							query.includes('from "users"') && state.user ? [state.user] : [],
						meta: { changes: 0 },
					}),
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				if (statements.some(({ query }) => query?.includes('from "users"')))
					state.authBatches++
				return executePreparedD1Batch(statements)
			},
		},
	} as unknown as Env
	async function request() {
		setAuthSessionSecret(secret)
		const cookie = await createAuthCookie(
			{
				stableUserId,
				email: 'page-auth@example.com',
				rememberMe: false,
			},
			true,
		)
		return new Request('https://example.com/_serverFn/read-account', {
			headers: { Cookie: cookie },
		})
	}
	return { state, env, request }
}

test('page authorization shares the middleware request lookup and still prefetches page flags', async () => {
	const { state, env, request } = authFixture()
	const original = await request()
	// Start middleware and its page handler must share the original Request.
	const [resolved, user] = await Promise.all([
		loadResolvedRequestAuth(original, env),
		requireAuthenticatedPageUser(original, env, {
			redirectTo: '/account?tab=profile',
		}),
	])
	expect(resolved.user?.username).toBe('page-user')
	expect(user).toMatchObject({
		username: 'page-user',
		userId: 7,
		mcpUser: { userId: stableUserId, personalOrgId },
		request: { org: { id: personalOrgId, slug: 'page-user' } },
	})
	expect(state.authBatches).toBe(1)
	expect(hasResolvedRequestFeatureFlags(original)).toBe(true)
	await loadRequestFeatureFlags(original, env, { userId: 7, stableUserId })
	// Deduplication ends at the HTTP request boundary, so revocation stays visible.
	state.user = null
	const denied = await requireAuthenticatedPageUser(await request(), env, {
		redirectTo: '/account?tab=profile',
	})
	expect(denied).toBeInstanceOf(Response)
	expect(state.authBatches).toBe(2)
})

test('RPC page targets survive anonymous, missing, deleting and suspended account redirects', async () => {
	const { state, env, request } = authFixture()
	const target = '/account/jobs?selected=job-1'
	const active = state.user!
	for (const condition of [
		'anonymous',
		'missing',
		'deleting',
		'suspended',
	] as const) {
		state.user =
			condition === 'missing'
				? null
				: {
						...active,
						deleting_at: condition === 'deleting' ? '2026-01-01' : null,
						suspended_at: condition === 'suspended' ? '2026-01-01' : null,
					}
		const original =
			condition === 'anonymous'
				? new Request('https://example.com/_serverFn/read-account')
				: await request()
		const result = await requireAuthenticatedPageUser(original, env, {
			redirectTo: target,
		})
		expect(result).toBeInstanceOf(Response)
		if (!(result instanceof Response))
			throw new Error('Expected login redirect')
		expect(result.status).toBe(302)
		const location = new URL(result.headers.get('Location')!)
		expect(location.pathname).toBe('/login')
		expect(location.searchParams.get('redirectTo')).toBe(target)
		if (condition === 'missing' || condition === 'deleting') {
			expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0')
		}
	}
	const regular = await requireAuthenticatedPageUser(
		new Request('https://example.com/account?tab=profile'),
		env,
	)
	expect(regular).toBeInstanceOf(Response)
	if (!(regular instanceof Response)) throw new Error('Expected login redirect')
	expect(
		new URL(regular.headers.get('Location')!).searchParams.get('redirectTo'),
	).toBe('/account?tab=profile')
})
