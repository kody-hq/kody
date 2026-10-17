import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadHome } from '../../../start/server/home.ts'
import { loadOnboardingData } from '#app/onboarding-data.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import type * as OnboardingData from '#app/onboarding-data.ts'

// Binding validation is covered separately; this unit exercises real auth batching.
vi.mock('#app/env.ts', () => ({ getEnv: (env: Env) => env }))

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/onboarding-data.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof OnboardingData>()
	return {
		...actual,
		loadOnboardingData: vi.fn(actual.loadOnboardingData),
	}
})

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/'),
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
}))
vi.mock('@tanstack/react-start', async () => ({
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))

test('native home leaves auth and flag reads to the session loader', async () => {
	setAuthSessionSecret(testCookieSecret)
	const email = 'home@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const session: AuthSession = {
		stableUserId,
		email,
		rememberMe: false,
	}
	const cookie = await createAuthCookie(session, false)
	const counts = { prepare: 0, batch: 0, batchSizes: [] as Array<number> }
	const userRow = {
		id: 7,
		email,
		username: 'home-user',
		stable_user_id: stableUserId,
	}
	// Rows the flag prefetch resolves: one global flag on, one user override on.
	const rowsFor = (query: string) => {
		const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
		if (q.startsWith('select') && q.includes('from "users"')) return [userRow]
		if (q.includes('from user_roles ur')) {
			return [
				{ role_name: 'user', action: 'read', entity: 'user', access: 'own' },
			]
		}
		if (q.includes('from feature_flags') && !q.includes('where')) {
			return [{ key: 'demo-indicator', enabled: 1, rollout_percent: null }]
		}
		if (
			q.includes('from feature_flag_user_overrides') &&
			q.includes('where user_id = ?')
		) {
			return [{ flag_key: 'execute-invoke', enabled: 1 }]
		}
		return []
	}
	const env = {
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: {
			prepare(query: string) {
				counts.prepare += 1
				const statement = {
					query,
					bind: () => statement,
					all: async () => ({ results: rowsFor(query), meta: { changes: 0 } }),
					first: async () => {
						const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
						if (isOrgBindingMembershipQuery(normalized)) {
							return mockPersonalOrgBindingRow(stableUserId, userRow.username)
						}
						return null
					},
					run: async () => ({ meta: { changes: 0 } }),
				}
				return statement
			},
			async batch(statements: Array<{ query?: string }>) {
				counts.batch += 1
				counts.batchSizes.push(statements.length)
				return await executePreparedD1Batch(statements)
			},
			exec: async () => undefined,
		} as unknown as D1Database,
	} as Env

	const request = new Request('https://example.com/', {
		headers: { Cookie: cookie },
	})
	native.env = env
	native.request = request

	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))
	const home = await loadHome()
	expect(counts.prepare).toBe(0)
	const body = await loadSessionInfo(request, env)
	expect(home.landingAgentOrder.length).toBeGreaterThan(0)
	expect(body.session?.username).toBe('home-user')
	expect(body.session?.featureFlags).toEqual({
		'demo-indicator': true,
		'jev-search-rerank': false,
		'execute-invoke': true,
		'connection-profiles': false,
		'mcp-skills-extension': false,
		'mcp-events-extension': false,
		'package-app-custom-domains': false,
		'repo-push-queue': false,
		'credential-need-enforcement': false,
	})
	expect(counts.batchSizes).toEqual([2, 3])
	expect(loadOnboardingData).not.toHaveBeenCalled()
	expect(home.landingHeroVideos).toEqual([])
	fetchMock.mockRestore()
})

test('native anonymous home omits the unused onboarding chooser catalog', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))

	setAuthSessionSecret(testCookieSecret)
	native.env = { COOKIE_SECRET: testCookieSecret } as Env
	native.request = new Request('https://example.com/')
	const home = await loadHome()
	expect(home.landingAgentOrder.length).toBeGreaterThan(0)
	expect(home.landingHeroVideos).toEqual([])
	expect(loadOnboardingData).not.toHaveBeenCalled()
	fetchMock.mockRestore()
})
