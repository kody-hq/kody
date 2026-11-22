import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import type { SoftDeletePurgeCandidate } from './purge.ts'
import { PurgeWebhookFailed } from './purge-webhook.ts'
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
	failWebhook?: Array<string>
	failAudit?: boolean
}) {
	const calls: Array<string> = []
	const clock = [...(input.clock ?? [])]
	function purgeStep(name: string) {
		return createAsyncLogic({
			run: async ({ input: next }: { input: SoftDeletePurgeCandidate }) => {
				calls.push(`${name}:${next.id}`)
				if (input.failPurge?.includes(next.id)) throw new Error('purge failed')
				if (input.failWebhook?.includes(next.id))
					throw new PurgeWebhookFailed(next, { status: 502 })
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
			recordWebhookFailure: createAsyncLogic({
				run: async ({
					input: failure,
				}: {
					input: {
						candidate: SoftDeletePurgeCandidate
						error: PurgeWebhookFailed
					}
				}) => {
					calls.push(`record_webhook_failure:${failure.candidate.id}`)
					if (input.failAudit) throw new Error('audit failed')
					return failure.error.message
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
	return { calls, output }
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

test('a failed purge webhook is recorded as its own failure and the pass continues', async () => {
	const { calls, output } = purge({
		candidates: [
			candidate('org-1', { kind: 'org', dbUserId: undefined }),
			candidate('user-1'),
			candidate('user-2'),
		],
		failWebhook: ['org-1', 'user-1'],
	})
	const result = await output
	expect(result).toMatchObject({ status: 'completed', purged: 1, failed: 2 })
	expect(calls).toEqual([
		'claim:org-1',
		'org:org-1',
		'record_webhook_failure:org-1',
		'claim:user-1',
		'user:user-1',
		'record_webhook_failure:user-1',
		'claim:user-2',
		'user:user-2',
	])
	expect(result.status === 'completed' && result.outcomes).toEqual([
		expect.objectContaining({
			id: 'org-1',
			outcome: 'webhook_failed',
			error: 'purge_webhook_failed:org:status_502',
		}),
		expect.objectContaining({
			id: 'user-1',
			outcome: 'webhook_failed',
			error: 'purge_webhook_failed:user:status_502',
		}),
		expect.objectContaining({ id: 'user-2', outcome: 'purged' }),
	])
})

test('a failed purge webhook audit fails the run', async () => {
	const { output } = purge({
		candidates: [candidate('user-1')],
		failWebhook: ['user-1'],
		failAudit: true,
	})
	expect(await output).toMatchObject({ status: 'run_failed' })
})
