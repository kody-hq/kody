import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as RepoSessionDueOwners from './repo-session-due-owners.ts'

const mockModule = vi.hoisted(() => ({
	listDueRepoSessionOwners: vi.fn(),
	runDueCleanup: vi.fn(),
	deferRepoSessionDueOwner: vi.fn<
		typeof RepoSessionDueOwners.deferRepoSessionDueOwner
	>(async () => undefined),
}))

vi.mock('./repo-session-due-owners.ts', () => ({
	repoSessionDueOwnerBatchSize: 25,
	listDueRepoSessionOwners: (...args: Array<unknown>) =>
		mockModule.listDueRepoSessionOwners(...args),
	deferRepoSessionDueOwner: (
		...args: Parameters<typeof RepoSessionDueOwners.deferRepoSessionDueOwner>
	) => mockModule.deferRepoSessionDueOwner(...args),
}))

vi.mock('./repo-session-index-client.ts', () => ({
	repoSessionIndexRpc: () => ({
		runDueCleanup: (...args: Array<unknown>) =>
			mockModule.runDueCleanup(...args),
	}),
}))

const { cleanupRepoSessionBranches } = await import('./repo-session-cleanup.ts')

test('repo session cleanup pages due owners and runs per-user index cleanup', async () => {
	mockModule.listDueRepoSessionOwners.mockResolvedValue([
		{ userId: ownerIdFromStored('user-1'), dueAt: '2026-06-24T19:00:00.000Z' },
		{ userId: ownerIdFromStored('user-2'), dueAt: '2026-06-24T19:30:00.000Z' },
	])
	mockModule.runDueCleanup
		.mockResolvedValueOnce({ checked: 2, deleted: 2, errors: 0 })
		.mockResolvedValueOnce({ checked: 1, deleted: 1, errors: 0 })

	const result = await cleanupRepoSessionBranches({
		env: { APP_DB: {} } as Env,
		now: new Date('2026-06-24T20:00:00.000Z'),
		batchSize: 10,
	})

	expect(mockModule.listDueRepoSessionOwners).toHaveBeenCalledWith({
		db: expect.anything(),
		now: new Date('2026-06-24T20:00:00.000Z'),
		limit: 10,
	})
	expect(mockModule.runDueCleanup).toHaveBeenNthCalledWith(1, {
		ownerId: ownerIdFromStored('user-1'),
		now: '2026-06-24T20:00:00.000Z',
	})
	expect(mockModule.runDueCleanup).toHaveBeenNthCalledWith(2, {
		ownerId: ownerIdFromStored('user-2'),
		now: '2026-06-24T20:00:00.000Z',
	})
	expect(result).toEqual({
		checked: 3,
		deleted: 3,
		errors: 0,
	})
})

test('a wedged index RPC defers its owner and later owners still run', async () => {
	vi.clearAllMocks()
	vi.useFakeTimers()
	try {
		mockModule.listDueRepoSessionOwners.mockResolvedValue([
			{
				userId: ownerIdFromStored('user-1'),
				dueAt: '2026-06-24T19:00:00.000Z',
			},
			{
				userId: ownerIdFromStored('user-2'),
				dueAt: '2026-06-24T19:30:00.000Z',
			},
		])
		mockModule.runDueCleanup
			.mockReturnValueOnce(new Promise(() => {}))
			.mockResolvedValueOnce({ checked: 1, deleted: 1, errors: 0 })
		let result: unknown
		void cleanupRepoSessionBranches({
			env: { APP_DB: {} } as Env,
			now: new Date('2026-06-24T20:00:00.000Z'),
		}).then((value) => {
			result = value
		})
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(result).toEqual({ checked: 1, deleted: 1, errors: 1 })
		expect(mockModule.deferRepoSessionDueOwner).toHaveBeenCalledWith(
			expect.objectContaining({ userId: ownerIdFromStored('user-1') }),
		)
	} finally {
		vi.useRealTimers()
	}
})
