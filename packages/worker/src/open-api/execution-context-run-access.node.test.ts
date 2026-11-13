import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	buildMcpUserContextFromGrantProps: vi.fn(),
	loadOrgBindingForOrg: vi.fn(),
	getExecutionContext: vi.fn(),
	loadContextAccess: vi.fn(),
	loadProfileChain: vi.fn(),
}))

vi.mock('#worker/mcp-auth-user-context.ts', () => ({
	buildMcpUserContextFromGrantProps: mocks.buildMcpUserContextFromGrantProps,
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: mocks.loadOrgBindingForOrg,
}))
vi.mock('#worker/execution-contexts/store.ts', () => ({
	getExecutionContext: mocks.getExecutionContext,
	loadContextAccess: mocks.loadContextAccess,
}))
vi.mock('#worker/profiles/store.ts', () => ({
	loadProfileChain: mocks.loadProfileChain,
}))

const { executionContextRunAccessReuseMs, loadExecutionContextRunAccess } =
	await import('./execution-context-run-access.ts')

const env = { APP_DB: {} } as Env
let runCounter = 0

function makeLease(overrides: Record<string, unknown> = {}) {
	return {
		ecid: 'ec_1',
		runId: `run_${runCounter}`,
		orgId: 'org_1',
		profileId: 'profile_1',
		requester: { userId: 'person_1' },
		...overrides,
	}
}

function readCalls() {
	return Object.values(mocks).reduce(
		(total, mock) => total + mock.mock.calls.length,
		0,
	)
}

beforeEach(() => {
	runCounter += 1
	mocks.buildMcpUserContextFromGrantProps.mockImplementation(
		async (_env: Env, { userId }: { userId: string }) => ({
			user: { userId, email: `${userId}@example.com` },
			suspended: false,
			emailVerified: true,
		}),
	)
	mocks.loadOrgBindingForOrg.mockImplementation(
		async (_db: unknown, userId: string, orgId: string) => ({
			orgId,
			userId,
			role: 'member',
		}),
	)
	mocks.getExecutionContext.mockImplementation(
		async (_db: unknown, ecid: string) => ({ id: ecid, operator_user_id: 'x' }),
	)
	mocks.loadContextAccess.mockResolvedValue({ usable: true })
	mocks.loadProfileChain.mockImplementation(
		async (_db: unknown, { profileId }: { profileId: string }) => [
			{ id: profileId },
		],
	)
})

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

test('a burst of calls in one run reads D1 access once', async () => {
	const lease = makeLease()
	const results = await Promise.all(
		Array.from({ length: 10 }, () => loadExecutionContextRunAccess(env, lease)),
	)
	await loadExecutionContextRunAccess(env, lease)
	expect(results.every((result) => result.ok)).toBe(true)
	// One requester, org, context, access, and profile read for 11 calls.
	expect(readCalls()).toBe(5)
})

test('each call gets its own copy of the shared access', async () => {
	const lease = makeLease()
	const first = await loadExecutionContextRunAccess(env, lease)
	if (!first.ok) throw new Error('expected access')
	first.authContext.user.email = 'changed@example.com'
	const second = await loadExecutionContextRunAccess(env, lease)
	if (!second.ok) throw new Error('expected access')
	expect(second.authContext.user.email).toBe('person_1@example.com')
})

test('revoked access is honored once the reuse window passes', async () => {
	vi.useFakeTimers()
	const lease = makeLease()
	expect((await loadExecutionContextRunAccess(env, lease)).ok).toBe(true)
	mocks.loadOrgBindingForOrg.mockResolvedValue(null)
	vi.advanceTimersByTime(executionContextRunAccessReuseMs - 1)
	expect((await loadExecutionContextRunAccess(env, lease)).ok).toBe(true)
	vi.advanceTimersByTime(1)
	expect(await loadExecutionContextRunAccess(env, lease)).toEqual({
		ok: false,
		reason: 'org',
	})
})

test.each([
	['suspended requester', 'requester'],
	['unusable context', 'context'],
] as const)('a %s is denied and never reused', async (_label, reason) => {
	const lease = makeLease()
	if (reason === 'requester') {
		mocks.buildMcpUserContextFromGrantProps.mockResolvedValueOnce({
			user: { userId: 'person_1' },
			suspended: true,
			emailVerified: true,
		})
	} else {
		mocks.loadContextAccess.mockResolvedValueOnce({ usable: false })
	}
	expect(await loadExecutionContextRunAccess(env, lease)).toEqual({
		ok: false,
		reason,
	})
	const before = readCalls()
	expect((await loadExecutionContextRunAccess(env, lease)).ok).toBe(true)
	expect(readCalls()).toBeGreaterThan(before)
})

test.each([
	['run', { runId: 'other_run' }],
	['context', { ecid: 'ec_2' }],
	['requester', { requester: { userId: 'person_2' } }],
	['org', { orgId: 'org_2' }],
	['profile', { profileId: 'profile_2' }],
	['no profile', { profileId: null }],
])('a different %s never reuses another decision', async (_label, change) => {
	await loadExecutionContextRunAccess(env, makeLease())
	const lease = makeLease(change)
	const before = mocks.buildMcpUserContextFromGrantProps.mock.calls.length
	const access = await loadExecutionContextRunAccess(env, lease)
	expect(mocks.buildMcpUserContextFromGrantProps.mock.calls.length).toBe(
		before + 1,
	)
	if (!access.ok) throw new Error('expected access')
	expect(access.authContext.user.userId).toBe(lease.requester.userId)
	expect(access.orgBinding.orgId).toBe(lease.orgId)
	expect(access.context.id).toBe(lease.ecid)
	expect(access.profileChain?.[0]?.id ?? null).toBe(lease.profileId)
})
