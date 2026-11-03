import {
	personIdFromStored,
	ownerIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as RepoSessions from '#worker/repo/repo-sessions.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { buildSourceRecoveryProblemMessage } from '#worker/repo/source-safety-policy.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import { cloudflareOpaqueInternalErrorMessage } from '#worker/sentry-options.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { repoOpenSessionInputSchema } from './repo-shared.ts'
import {
	isLiveSeatCountQuery,
	mockLiveSeatCountRow,
} from '#worker/test-support/live-seat-count-query.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockModule = vi.hoisted(() => ({
	getActiveRepoSessionByConversation: vi.fn(),
	countActiveRepoSessions: vi.fn<typeof RepoSessions.countActiveRepoSessions>(
		async () => 0,
	),
	getEntitySourceByIdForUser: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	repoSessionRpc: vi.fn(),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	getActiveRepoSessionByConversation: (...args: Array<unknown>) =>
		mockModule.getActiveRepoSessionByConversation(...args),
	countActiveRepoSessions: (
		...args: Parameters<typeof RepoSessions.countActiveRepoSessions>
	) => mockModule.countActiveRepoSessions(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

const { repoOpenSessionCapability } = await import('./repo-open-session.ts')

function createEntitlementsDatabase(user: {
	email: string
	plan: string
	stable_user_id: string
}) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (query.includes('SELECT 1 AS present FROM users')) {
								const [email, stableUserId] = params
								return email === user.email &&
									stableUserId === user.stable_user_id
									? { present: 1 }
									: null
							}
							if (
								query.includes('SELECT plan, stripe_plan') ||
								query.includes('entitlement_ladder')
							) {
								const [email, stableUserId] = params
								return email === user.email &&
									stableUserId === user.stable_user_id
									? { plan: user.plan }
									: null
							}
							if (isLiveSeatCountQuery(query)) {
								return mockLiveSeatCountRow()
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all() {
							if (query.includes('FROM org_limit_overrides')) {
								return { results: [] }
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createPackageSourceRow(userId: string): EntitySourceRow {
	return {
		id: 'source-package-1',
		user_id: ownerIdFromStored(userId),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-package-1',
		published_commit: 'commit-package-1',
		indexed_commit: 'commit-package-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
	}
}

function createSavedPackageRow(userId: string) {
	return {
		id: 'package-1',
		userId,
		name: '@kody/triage-github-pr',
		kodyId: 'triage-github-pr',
		description: 'Triages one PR',
		tags: ['github', 'triage'],
		searchText: null,
		sourceId: 'source-package-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-18T00:00:00.000Z',
		updatedAt: '2026-04-18T00:00:00.000Z',
	}
}

function createOpenSessionResult(id = 'session-new') {
	return {
		id,
		source_id: 'source-package-1',
		source_root: '/',
		base_commit: 'commit-package-1',
		session_branch: 'sessions/session-new',
		source_branch: 'main',
		conversation_id: null,
		last_checkpoint_commit: 'commit-package-1',
		last_check_run_id: null,
		last_check_tree_hash: null,
		expires_at: null,
		created_at: '2026-04-18T00:01:00.000Z',
		updated_at: '2026-04-18T00:01:00.000Z',
		published_commit: 'commit-package-1',
		manifest_path: 'package.json',
		entity_type: 'package',
	}
}

async function setup({
	email,
	plan = 'pro',
	activeSessions = 0,
}: {
	email: string
	plan?: string
	activeSessions?: number | null
}) {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	const userId = testStableUserIdFromEmail(email)
	mockModule.countActiveRepoSessions.mockResolvedValue(activeSessions ?? 0)
	mockModule.getActiveRepoSessionByConversation.mockResolvedValue(null)
	mockModule.resolveSavedPackageRef.mockResolvedValue(
		createSavedPackageRow(userId),
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValue(
		createPackageSourceRow(userId),
	)
	const rpc = { openSession: vi.fn(), getSessionInfo: vi.fn() }
	mockModule.repoSessionRpc.mockReturnValue(rpc)
	const ctx = {
		env: {
			APP_DB: createEntitlementsDatabase({
				email,
				plan,
				stable_user_id: userId,
			}),
		} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored(userId),
				username: 'kody',
				email,
				displayName: 'Repo User',
			},
		}),
	}
	const open = (input: { kody_id?: string; conversation_id?: string } = {}) =>
		repoOpenSessionCapability.handler(
			{
				target: {
					kind: 'package',
					kody_id: input.kody_id ?? 'triage-github-pr',
				},
				...(input.conversation_id
					? { conversation_id: input.conversation_id }
					: {}),
			},
			ctx,
		)
	return { userId, rpc, open }
}

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)

test('repo target accepts camelCase aliases for its snake_case fields', () => {
	// Agents guess `kodyId` / `packageId` often enough that the schema
	// normalizes both spellings instead of failing the round trip.
	const cases = [
		[{ kodyId: 'triage-github-pr' }, { kody_id: 'triage-github-pr' }],
		[{ packageId: 'package-1' }, { package_id: 'package-1' }],
		[{ kody_id: 'triage-github-pr' }, { kody_id: 'triage-github-pr' }],
	]
	expect(
		cases.map(
			([target]) =>
				repoOpenSessionInputSchema.parse({
					target: { kind: 'package', ...target },
				}).target,
		),
	).toEqual(cases.map(([, want]) => ({ kind: 'package', ...want })))
})

test('repoOpenSession maps published HEAD mismatch to McpCallerError', async () => {
	const { userId, rpc, open } = await setup({
		email: 'head-mismatch@example.com',
	})
	const source = createPackageSourceRow(userId)
	rpc.openSession.mockRejectedValueOnce(
		new Error(
			buildSourceRecoveryProblemMessage({
				source,
				operation: 'repoOpenSession',
				reason: `artifact source repo "${source.repo_id}" default branch HEAD "commit-unpublished" does not match published commit "${source.published_commit}"`,
			}),
		),
	)

	const error = await rejection(open())

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: expect.stringContaining('packagePublishExternalPush'),
	})
	expect(rpc.openSession).toHaveBeenCalled()
})

test('repoOpenSession allows below-limit usage and denies new sessions at the pro and max plan ceilings', async () => {
	const below = await setup({ email: 'max@example.com', plan: 'max' })
	below.rpc.openSession.mockResolvedValueOnce(createOpenSessionResult())
	expect((await below.open()).id).toBe('session-new')
	expect(below.rpc.openSession).toHaveBeenCalled()

	for (const plan of ['pro', 'max'] as const) {
		const limit = planLimits[plan].maxRepoSessions
		if (limit === null) throw new Error(`Expected a numeric ${plan} limit.`)
		const { rpc, open } = await setup({
			email: `${plan}@example.com`,
			plan,
			activeSessions: limit,
		})

		const error = await rejection(open({ conversation_id: 'conversation-1' }))

		if (!isEntitlementLimitError(error)) {
			throw new Error(`Expected an EntitlementLimitError for ${plan}.`)
		}
		expect(error.details).toMatchObject({
			code: 'entitlement_limit_exceeded',
			resource: 'repo_sessions',
			plan,
			limit,
			current: limit,
		})
		expect(rpc.openSession).not.toHaveBeenCalled()
	}
})

test('repoOpenSession resumes an existing active session without enforcing the repo sessions entitlement', async () => {
	const limit = planLimits.pro.maxRepoSessions
	const { userId, rpc, open } = await setup({
		email: 'planned@example.com',
		activeSessions: limit,
	})
	mockModule.getActiveRepoSessionByConversation.mockResolvedValueOnce({
		id: 'session-existing',
		source_id: 'source-package-1',
	})
	rpc.getSessionInfo.mockResolvedValueOnce(
		createOpenSessionResult('session-existing'),
	)

	const resumed = await open({ conversation_id: 'conversation-1' })

	expect(resumed.id).toBe('session-existing')
	expect(rpc.getSessionInfo).toHaveBeenCalledWith({
		sessionId: 'session-existing',
		userId,
	})
	expect(rpc.openSession).not.toHaveBeenCalled()
})

test('repoOpenSession mints a new session when conversation_id is omitted', async () => {
	const { userId, rpc, open } = await setup({ email: 'mint-new@example.com' })
	rpc.openSession.mockResolvedValueOnce(
		createOpenSessionResult('session-minted'),
	)

	const opened = await open()

	expect(opened.id).toBe('session-minted')
	expect(mockModule.getActiveRepoSessionByConversation).not.toHaveBeenCalled()
	expect(rpc.getSessionInfo).not.toHaveBeenCalled()
	expect(rpc.openSession).toHaveBeenCalledWith(
		expect.objectContaining({
			userId,
			sourceId: 'source-package-1',
			conversationId: null,
		}),
	)
	expect(mockModule.countActiveRepoSessions).toHaveBeenCalled()
})

test('repoOpenSession opens a package by scoped @owner/leaf the same as the name leaf', async () => {
	const { userId, rpc, open } = await setup({
		email: 'scoped-name@example.com',
	})
	rpc.openSession
		.mockResolvedValueOnce(createOpenSessionResult('session-scoped'))
		.mockResolvedValueOnce(createOpenSessionResult('session-leaf'))

	const scoped = await open({ kody_id: '@kody/triage-github-pr' })
	const leaf = await open({ kody_id: 'triage-github-pr' })

	expect(scoped.resolved_target).toEqual({
		kind: 'package',
		source_id: 'source-package-1',
		package_id: 'package-1',
		kody_id: 'triage-github-pr',
		name: '@kody/triage-github-pr',
	})
	expect(leaf.resolved_target).toEqual(scoped.resolved_target)
	expect(mockModule.resolveSavedPackageRef.mock.calls).toEqual([
		[expect.anything(), { userId, ref: 'triage-github-pr', match: 'slug' }],
		[expect.anything(), { userId, ref: 'triage-github-pr', match: 'slug' }],
	])
})

test('repoOpenSession retries opaque Cloudflare internal errors then rethrows when exhausted', async () => {
	consoleWarn.mockImplementation(() => {})
	const recovered = await setup({ email: 'opaque-internal@example.com' })
	recovered.rpc.openSession
		.mockRejectedValueOnce(new Error(cloudflareOpaqueInternalErrorMessage))
		.mockResolvedValueOnce(createOpenSessionResult())

	expect((await recovered.open()).id).toBe('session-new')
	const sessionIds = recovered.rpc.openSession.mock.calls.map(
		(call) => (call[0] as { sessionId: unknown }).sessionId,
	)
	expect(sessionIds).toEqual([expect.any(String), expect.any(String)])
	expect(sessionIds[0]).not.toBe(sessionIds[1])
	expect(mockModule.repoSessionRpc).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining(
			'repoOpenSession transient Cloudflare opaque internal error',
		),
	)

	const exhausted = await setup({ email: 'opaque-exhausted@example.com' })
	exhausted.rpc.openSession.mockRejectedValue(
		new Error(cloudflareOpaqueInternalErrorMessage),
	)

	expect(await rejection(exhausted.open())).toMatchObject({
		message: cloudflareOpaqueInternalErrorMessage,
	})
	// Initial attempt + two delayed retries.
	expect(exhausted.rpc.openSession).toHaveBeenCalledTimes(3)
})
