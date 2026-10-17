import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	createAuthCookie,
	setAuthSessionSecret,
	type AuthSession,
} from '#app/auth-session.ts'
import { loadAccountPage } from '../../../start/server/account-page.ts'
import { loadSessionInfo } from '#app/session-info.ts'
import { executePreparedD1Batch } from '#worker/test-support/d1-prepared-batch.ts'
import {
	isOrgBindingMembershipQuery,
	mockPersonalOrgBindingRow,
} from '#worker/test-support/org-binding-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const testCookieSecret = 'test-cookie-secret-0123456789abcdef0123456789'

vi.mock('#app/account-profile-data.ts', () => ({
	loadAccountProfileData: vi.fn(async () => ({
		ok: true,
		email: 'account@example.com',
		emailVerified: false,
		username: 'account-user',
		displayName: 'account-user',
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	})),
}))

vi.mock('#app/account-connections-data.ts', () => ({
	loadAccountConnectionsData: vi.fn(async () => ({
		ok: true,
		connections: [],
		canDisconnect: false,
		hasUsablePassword: true,
		availableProviders: [],
		canSyncDiscordRoles: false,
	})),
}))

vi.mock('#app/onboarding-data.ts', () => ({
	loadOnboardingData: vi.fn(async () => ({
		ok: true,
		loggedIn: true,
		username: 'account-user',
		mcpServerUrl: 'https://example.com/mcp',
		setupPrompt: '',
		discoveryPrompt: '',
		persistPrompt: '',
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		connectedAgents: [],
		secondAgentStandardGift: {
			received: false,
			active: false,
			status: 'none',
			expiresAt: null,
			grantedAt: null,
		},
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		featuredMcpServers: [],
		customMcpServers: [],
		persistedPackageName: null,
		accessWinMemorySubject: null,
		checklist: null,
	})),
}))

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/account'),
	setResponseHeader: vi.fn(),
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: (env: Env) => env }))
vi.mock('@tanstack/react-start', async () => ({
	getGlobalStartContext: () => ({ env: native.env }),
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))

type Rows = Array<Record<string, unknown>>

function createAccountEnv(
	rows: {
		users?: Rows
		roles?: Rows
		flags?: Rows
		overrides?: Rows
	} = {},
) {
	const counts = { prepare: 0, batch: 0, batchSizes: [] as Array<number> }
	const resultsFor = (normalizedQuery: string) => {
		if (
			normalizedQuery.startsWith('select') &&
			normalizedQuery.includes('from "users"')
		) {
			return rows.users
		}
		if (normalizedQuery.includes('from user_roles ur')) return rows.roles
		if (
			normalizedQuery.includes('from feature_flags') &&
			!normalizedQuery.includes('where')
		) {
			return rows.flags
		}
		if (
			normalizedQuery.includes('from feature_flag_user_overrides') &&
			normalizedQuery.includes('where user_id = ?')
		) {
			return rows.overrides
		}
		return undefined
	}
	const env = {
		COOKIE_SECRET: testCookieSecret,
		FLAG_EXPOSURES: { writeDataPoint() {} },
		APP_DB: {
			prepare(query: string) {
				counts.prepare += 1
				const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
				const statement = {
					query,
					bind: (...params: Array<unknown>) => {
						statement.bindParams = params
						return statement
					},
					bindParams: [] as Array<unknown>,
					all: async () => ({
						results: resultsFor(normalizedQuery) ?? [],
						meta: { changes: 0 },
					}),
					first: async () => {
						if (isOrgBindingMembershipQuery(normalizedQuery)) {
							const personId = String(statement.bindParams[0] ?? '')
							const user = (rows.users ?? []).find(
								(row) => row.stable_user_id === personId,
							)
							return user
								? mockPersonalOrgBindingRow(
										personId,
										typeof user.username === 'string' ? user.username : null,
									)
								: null
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
			async exec() {
				return
			},
		} as unknown as D1Database,
	} as Env
	return { env, counts }
}

async function getAccount(env: Env, session: AuthSession) {
	setAuthSessionSecret(testCookieSecret)
	const cookie = await createAuthCookie(session, false)
	native.env = env
	native.request = new Request('https://example.com/account', {
		headers: { Cookie: cookie },
	})
	native.setResponseHeader.mockClear()
	return loadAccountPage({ data: '' })
}

test('native account loader redirects to login with a session-destroy cookie for stale, deleting, or soft-deleted accounts', async () => {
	const deletingUserId = 'a'.repeat(64)
	const softDeletedUserId = 'b'.repeat(64)
	const cases = [
		{
			stableUserId: ownerIdFromStored('f').repeat(64),
			email: 'missing@example.com',
			users: [],
		},
		{
			stableUserId: deletingUserId,
			email: 'deleting@example.com',
			users: [
				{
					id: 7,
					email: 'deleting@example.com',
					username: 'deleting-user',
					stable_user_id: deletingUserId,
					deleting_at: '2026-08-31 15:00:00',
				},
			],
		},
		{
			label: 'soft-deleted account',
			stableUserId: softDeletedUserId,
			email: 'soft-deleted@example.com',
			users: [
				{
					id: 800,
					email: 'soft-deleted@example.com',
					username: 'soft-deleted-user',
					stable_user_id: softDeletedUserId,
					deleted_at: '2026-10-16T22:23:07.000Z',
				},
			],
		},
	]
	for (const { stableUserId, email, users } of cases) {
		const { env } = createAccountEnv({ users })
		await expect(
			getAccount(env, { stableUserId, email, rememberMe: false }),
		).rejects.toMatchObject({
			options: {
				statusCode: 302,
				href: 'https://example.com/login?redirectTo=%2Faccount',
			},
		})
		const cookie = native.setResponseHeader.mock.calls.find(
			([name]) => name === 'Set-Cookie',
		)?.[1] as string | undefined
		expect(cookie).toContain('kody_session=')
		expect(cookie).toContain('Max-Age=0')
	}
})

test('native account and session reads batch user/role and flag reads into two round trips', async () => {
	const email = 'account@example.com'
	const stableUserId = testStableUserIdFromEmail(email)
	const { env, counts } = createAccountEnv({
		users: [
			{ id: 7, email, username: 'account-user', stable_user_id: stableUserId },
		],
		roles: [
			{ role_name: 'user', action: 'read', entity: 'user', access: 'own' },
		],
		flags: [{ key: 'demo-indicator', enabled: 1, rollout_percent: null }],
		overrides: [{ flag_key: 'execute-invoke', enabled: 1 }],
	})

	const response = await getAccount(env, {
		stableUserId,
		email,
		rememberMe: false,
	})
	const body = await loadSessionInfo(native.request, env)
	expect(body.session?.username).toBe('account-user')
	expect(body.session?.roles).toEqual(['user'])
	expect(body.session?.permissions).toEqual(['read:user:own'])
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
	expect(Object.keys(response.payloads).sort()).toEqual([
		'accountConnections',
		'accountProfile',
		'onboarding',
	])
	// Session batches: users+roles, then flags+overrides+experiments_opt_in.
	// Organization list, invite list, and pending invite-link list are extra
	// prepares on the session shell only; the account page itself no longer
	// lists organizations (inviteCount derives from the listed invites and
	// links, so there is no separate COUNT query).
	expect(counts.batchSizes).toEqual([2, 3])
	expect(counts.prepare).toBe(10)
	expect(counts.batch).toBe(2)
})
