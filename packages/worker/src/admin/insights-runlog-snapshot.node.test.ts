import { expect, test, vi } from 'vitest'
import { type RunLogAdminInsightsSnapshot } from '#worker/run-records/admin-insights-snapshot.ts'
import {
	adminInsightsRunLogConcurrency,
	adminInsightsRunLogMaxUsersPerTick,
	adminInsightsRunLogSnapshotKvKey,
	readAdminInsightsRunLogSnapshot,
	refreshAdminInsightsRunLogSnapshot,
} from './insights-runlog-snapshot.ts'

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
const runLogMocks = vi.hoisted(() => ({
	getAdminInsightsSnapshot:
		vi.fn<
			(input: {
				env: Env
				userId: string
			}) => Promise<RunLogAdminInsightsSnapshot>
		>(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getAdminInsightsSnapshot: (input: { env: Env; userId: string }) =>
		runLogMocks.getAdminInsightsSnapshot(input),
}))

function emptySnapshot(): RunLogAdminInsightsSnapshot {
	return {
		workflowStatusCounts: [],
		activationMilestones: [],
		jobRunCounts: { success: 0, error: 0 },
	}
}

function createMemoryKv() {
	const store = new Map<string, string>()
	return {
		store,
		async get<T>(key: string, type?: 'json' | 'text') {
			const raw = store.get(key)
			if (raw == null) return null
			return type === 'json' ? (JSON.parse(raw) as T) : raw
		},
		async put(key: string, value: string) {
			store.set(key, value)
		},
	} as unknown as KVNamespace & { store: Map<string, string> }
}

function createUsersDb(
	users: Array<{ stable_user_id: string; email_verified_at: string | null }>,
) {
	return {
		prepare(query: string) {
			const statement = {
				bind() {
					return statement
				},
				async all<T>() {
					if (
						query.includes('stable_user_id') &&
						query.includes('deleting_at IS NULL')
					) {
						return { results: users as Array<T> }
					}
					throw new Error(`Unsupported query: ${query}`)
				},
			}
			return statement
		},
	} as unknown as D1Database
}

function verifiedUser(stable_user_id: string) {
	return {
		stable_user_id: ownerIdFromStored(stable_user_id),
		email_verified_at: '2026-09-01T00:00:00.000Z',
	}
}

const now = new Date('2026-09-10T18:00:00.000Z')

function refresh(
	users: Array<ReturnType<typeof verifiedUser>>,
	kv: KVNamespace | undefined,
) {
	return refreshAdminInsightsRunLogSnapshot({
		env: { APP_DB: createUsersDb(users), BUNDLE_ARTIFACTS_KV: kv } as Env,
		now,
	})
}

test('refreshAdminInsightsRunLogSnapshot writes a content-free KV snapshot and bounds concurrency', async () => {
	let inFlight = 0
	let maxInFlight = 0
	runLogMocks.getAdminInsightsSnapshot.mockImplementation(async (input) => {
		inFlight += 1
		maxInFlight = Math.max(maxInFlight, inFlight)
		await Promise.resolve()
		inFlight -= 1
		if (input.userId !== 'user-a') return emptySnapshot()
		return {
			workflowStatusCounts: [{ status: 'complete', count: 2 }],
			jobRunCounts: { success: 3, error: 1 },
			activationMilestones: [
				{
					milestone: 'package_run_succeeded',
					reachedAt: '2026-09-10T12:00:00.000Z',
					packageId: 'opaque-pkg',
				},
			],
		}
	})
	const kv = createMemoryKv()
	const snapshot = await refresh(
		[verifiedUser('user-a'), verifiedUser('user-b')],
		kv,
	)

	expect(snapshot).toMatchObject({
		workflowRuns: 2,
		jobSuccessRuns: 3,
		packageRunSucceededUsers: 1,
		complete: true,
		snapshotUpdatedAt: now.toISOString(),
	})
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(2)
	expect(maxInFlight).toBeLessThanOrEqual(adminInsightsRunLogConcurrency)
	expect(kv.store.get(adminInsightsRunLogSnapshotKvKey)).not.toContain(
		'opaque-pkg',
	)
	expect(await readAdminInsightsRunLogSnapshot(kv)).toMatchObject({
		workflowRuns: 2,
		snapshotUpdatedAt: now.toISOString(),
		complete: true,
	})
})

test('readAdminInsightsRunLogSnapshot degrades when KV is missing or empty', async () => {
	expect(await readAdminInsightsRunLogSnapshot(undefined)).toMatchObject({
		complete: false,
		snapshotUpdatedAt: null,
		workflowRuns: 0,
	})
	expect(await readAdminInsightsRunLogSnapshot(createMemoryKv())).toMatchObject(
		{ complete: false, snapshotUpdatedAt: null },
	)
})

test('refreshAdminInsightsRunLogSnapshot throws when the KV write fails', async () => {
	runLogMocks.getAdminInsightsSnapshot.mockResolvedValue(emptySnapshot())
	const kv = createMemoryKv()
	kv.put = async () => {
		throw new Error('kv write failed')
	}
	await expect(refresh([verifiedUser('user-a')], kv)).rejects.toThrow(
		/kv write failed/,
	)
})

test('refreshAdminInsightsRunLogSnapshot caps per-tick fanout and marks the snapshot incomplete', async () => {
	runLogMocks.getAdminInsightsSnapshot.mockResolvedValue(emptySnapshot())
	const kv = createMemoryKv()
	const users = Array.from(
		{ length: adminInsightsRunLogMaxUsersPerTick + 1 },
		(_, index) => verifiedUser(`user-${String(index + 1).padStart(4, '0')}`),
	)
	const capped = {
		complete: false,
		usersAttempted: adminInsightsRunLogMaxUsersPerTick,
	}
	expect(await refresh(users, kv)).toMatchObject(capped)
	expect(runLogMocks.getAdminInsightsSnapshot).toHaveBeenCalledTimes(
		adminInsightsRunLogMaxUsersPerTick,
	)
	expect(
		JSON.parse(kv.store.get(adminInsightsRunLogSnapshotKvKey) ?? '{}'),
	).toMatchObject(capped)
})
