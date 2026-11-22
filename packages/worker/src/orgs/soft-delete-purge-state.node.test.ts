import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import type { SoftDeletePurgeCandidate } from './purge.ts'
import { softDeletePurgeBatchState } from './soft-delete-purge-state.ts'

function candidate(
	id: string,
	patch: Partial<SoftDeletePurgeCandidate> = {},
): SoftDeletePurgeCandidate {
	return {
		kind: 'user',
		id: id as OwnerId,
		deletedAt: '2026-01-01T00:00:00.000Z',
		ageDays: 40,
		dbUserId: 1,
		...patch,
	}
}

function purge(input: {
	candidates: Array<SoftDeletePurgeCandidate>
	dryRun?: boolean
	legacyDryRun?: boolean
	clock?: Array<number>
	refuseClaim?: Array<string>
	failPurge?: Array<string>
	failAudit?: boolean
	blockOn?: Array<string>
}) {
	const calls: Array<string> = []
	const fences: Array<string> = []
	const blocked: Array<{ id: string; attempts: number; lastFailure: string }> =
		[]
	const clock = [...(input.clock ?? [])]
	function purgeStep(name: string) {
		return createAsyncLogic({
			run: async ({ input: next }: { input: SoftDeletePurgeCandidate }) => {
				calls.push(`${name}:${next.id}`)
				if (input.failPurge?.includes(next.id)) throw new Error('purge failed')
			},
		})
	}
	const machine = softDeletePurgeBatchState.provide({
		actors: {
			listCandidates: createAsyncLogic({
				run: async () => ({
					scanned: input.candidates.length,
					candidates: input.candidates,
				}),
			}),
			readClock: createAsyncLogic({ run: async () => clock.shift() ?? 0 }),
			claimCandidate: createAsyncLogic({
				run: async ({ input: next }: { input: SoftDeletePurgeCandidate }) => {
					calls.push(`claim:${next.id}`)
					return !input.refuseClaim?.includes(next.id)
				},
			}),
			purgeOrg: purgeStep('org'),
			finishLegacyUser: purgeStep('legacy'),
			purgeUser: purgeStep('user'),
			recordFailure: createAsyncLogic({
				run: async ({
					input: failure,
				}: {
					input: { candidate: SoftDeletePurgeCandidate; error: unknown }
				}) => {
					calls.push(`record_failure:${failure.candidate.id}`)
					if (input.failAudit) throw new Error('audit failed')
					return failure.error instanceof Error
						? failure.error.message
						: String(failure.error)
				},
			}),
			fenceFailure: createAsyncLogic({
				run: async ({ input: next }: { input: SoftDeletePurgeCandidate }) => {
					fences.push(next.id)
					const isBlocked = input.blockOn?.includes(next.id) === true
					return { attempts: isBlocked ? 5 : 1, blocked: isBlocked }
				},
			}),
			recordBlocked: createAsyncLogic({
				run: async ({
					input: block,
				}: {
					input: {
						candidate: SoftDeletePurgeCandidate
						attempts: number
						lastFailure: string
					}
				}) => {
					blocked.push({
						id: block.candidate.id,
						attempts: block.attempts,
						lastFailure: block.lastFailure,
					})
				},
			}),
		},
	})
	const output = toPromise(
		createActor(machine, {
			input: {
				dryRun: input.dryRun ?? false,
				legacyDryRun: input.legacyDryRun ?? false,
				started: 0,
				budgetMs: 100,
			},
		}).start(),
	)
	return { calls, fences, blocked, output }
}

test('each candidate is claimed before the hard purge for its kind', async () => {
	const { calls, output } = purge({
		candidates: [
			candidate('org-1', { kind: 'org', dbUserId: undefined }),
			candidate('legacy-1', { legacy: true }),
			candidate('user-1'),
		],
	})
	expect(await output).toMatchObject({
		status: 'completed',
		purged: 3,
		failed: 0,
	})
	expect(calls).toEqual([
		'claim:org-1',
		'org:org-1',
		'claim:legacy-1',
		'legacy:legacy-1',
		'claim:user-1',
		'user:user-1',
	])
})

test('dry-run candidates are previewed without a claim or a purge', async () => {
	const { calls, output } = purge({
		candidates: [candidate('user-1'), candidate('legacy-1', { legacy: true })],
		dryRun: true,
	})
	const result = await output
	expect(result).toMatchObject({ status: 'completed', purged: 1 })
	expect(calls).toEqual(['claim:legacy-1', 'legacy:legacy-1'])
	expect(result.status === 'completed' && result.outcomes[0]).toMatchObject({
		id: 'user-1',
		outcome: 'would_purge',
	})
})

test('a refused claim is skipped, and a failed purge or missing users id is recorded before the next candidate', async () => {
	const { calls, output } = purge({
		candidates: [
			candidate('user-1'),
			candidate('user-2'),
			candidate('user-3', { dbUserId: undefined }),
			candidate('user-4'),
		],
		refuseClaim: ['user-1'],
		failPurge: ['user-2'],
	})
	const result = await output
	expect(result).toMatchObject({ status: 'completed', purged: 1, failed: 2 })
	expect(calls).toEqual([
		'claim:user-1',
		'claim:user-2',
		'user:user-2',
		'record_failure:user-2',
		'claim:user-3',
		'record_failure:user-3',
		'claim:user-4',
		'user:user-4',
	])
	expect(result.status === 'completed' && result.outcomes).toMatchObject([
		{ id: 'user-1', outcome: 'skipped_claim' },
		{ id: 'user-2', outcome: 'failed', error: 'purge failed' },
		{
			id: 'user-3',
			outcome: 'failed',
			error: 'user_purge_missing_db_id:user-3',
		},
		{ id: 'user-4', outcome: 'purged' },
	])
})

test('the time budget is checked before each claim', async () => {
	const { calls, output } = purge({
		candidates: [candidate('user-1'), candidate('user-2')],
		clock: [50, 101],
	})
	expect(await output).toMatchObject({
		status: 'completed',
		purged: 1,
		timeBudgetExhausted: true,
	})
	expect(calls).toEqual(['claim:user-1', 'user:user-1'])
})

test('a failed failure audit fails the run', async () => {
	const { output } = purge({
		candidates: [candidate('user-1'), candidate('user-2')],
		failPurge: ['user-1'],
		failAudit: true,
	})
	expect(await output).toMatchObject({ status: 'run_failed' })
})

test('each recorded failure is fenced, and only a newly blocked one records purge.blocked', async () => {
	const { output, fences, blocked } = purge({
		candidates: [candidate('user-1'), candidate('user-2'), candidate('user-3')],
		failPurge: ['user-1', 'user-2'],
		blockOn: ['user-2'],
	})
	expect(await output).toMatchObject({
		status: 'completed',
		purged: 1,
		failed: 2,
		outcomes: [
			{ id: 'user-1', outcome: 'failed', error: 'purge failed' },
			{ id: 'user-2', outcome: 'failed', error: 'purge failed' },
			{ id: 'user-3', outcome: 'purged' },
		],
	})
	expect(fences).toEqual(['user-1', 'user-2'])
	expect(blocked).toEqual([
		{ id: 'user-2', attempts: 5, lastFailure: 'purge failed' },
	])
})
