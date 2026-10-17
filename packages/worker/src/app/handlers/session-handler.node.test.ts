import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { createSessionHandler } from '#app/handlers/session.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'
const rememberedSession: AuthSession = {
	stableUserId: testStableUserIdFromEmail('user@example.com'),
	email: 'user@example.com',
	rememberMe: true,
}

function createSessionTestDb() {
	const userRow = {
		id: 1,
		email: 'user@example.com',
		username: 'session-user',
		password_hash: 'unused',
		stable_user_id: rememberedSession.stableUserId,
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
	// Everything but the user lookup (roles, feature flags) resolves empty so
	// /session falls back to registry defaults.
	const createStatement = (query: string, params: Array<unknown> = []) => {
		const isUserLookup =
			/^select[\s\S]*from "users"[\s\S]*"stable_user_id"\s*=/i.test(
				query.trim(),
			)
		const rows =
			isUserLookup && params[0] === userRow.stable_user_id ? [userRow] : []
		return {
			query,
			bind: (...next: Array<unknown>) => createStatement(query, next),
			all: async () => ({
				results: rows,
				meta: { changes: 0, last_row_id: 0 },
			}),
			first: async () => rows[0] ?? null,
			run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
		}
	}
	return {
		prepare: (query: string) => createStatement(query),
		batch: (statements: Array<{ query?: string }>) =>
			executePreparedD1Batch(statements),
		exec: async () => undefined,
	} as unknown as D1Database
}

function setupSession() {
	setAuthSessionSecret(testCookieSecret)
	const session = createSessionHandler({
		APP_DB: createSessionTestDb(),
		COOKIE_SECRET: testCookieSecret,
	} as Env)
	return (cookie: string) =>
		session({
			request: new Request('http://example.com/session', {
				headers: { Cookie: cookie },
			}),
		})
}

test('session handler only renews remembered sessions after the renewal window', async () => {
	const fetchSession = setupSession()
	const now = Date.UTC(2026, 1, 1)
	vi.spyOn(Date, 'now').mockReturnValue(now)
	for (const { ageDays, renewed } of [
		{ ageDays: 15, renewed: true },
		{ ageDays: 13, renewed: false },
	]) {
		const cookie = await createAuthCookie(
			rememberedSession,
			false,
			now - 1000 * 60 * 60 * 24 * ageDays,
		)
		const response = await fetchSession(cookie)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			ok: true,
			session: {
				email: rememberedSession.email,
				emailVerified: false,
				emailVerificationDelivery: null,
				username: 'session-user',
				avatarUrl: null,
				roles: [],
				permissions: [],
				featureFlags: {
					'demo-indicator': false,
					'jev-search-rerank': false,
					'execute-invoke': false,
					'connection-profiles': false,
					'mcp-skills-extension': false,
					'mcp-events-extension': false,
					'package-app-custom-domains': false,
					'repo-push-queue': false,
					'credential-need-enforcement': false,
				},
				organizations: [],
				inviteCount: 0,
			},
		})
		const setCookie = response.headers.get('Set-Cookie')
		expect({ ageDays, setCookie }).toEqual({
			ageDays,
			setCookie: renewed ? expect.stringContaining('Max-Age=2592000') : null,
		})
	}
})

test('session handler clears cookies for unknown stable user ids', async () => {
	const fetchSession = setupSession()
	for (const [stableUserId, email] of [
		['f'.repeat(64), 'missing@example.com'],
		['e'.repeat(64), 'user@example.com'],
	] as const) {
		const response = await fetchSession(
			await createAuthCookie({ stableUserId, email, rememberMe: false }, false),
		)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ ok: false })
		expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
	}
})
