import { createAsyncLogic, setup, types } from 'xstate'
import type {
	SoftDeletePurgeCandidate,
	SoftDeletePurgeOutcome,
} from '#worker/orgs/purge.ts'
import { TransientRetryBudgetExhausted } from '#worker/d1-item-retry.ts'

export type SoftDeletePurgeBatchOutput =
	| {
			status: 'completed'
			scanned: number
			purged: number
			failed: number
			timeBudgetExhausted: boolean
			outcomes: Array<SoftDeletePurgeOutcome>
	  }
	| { status: 'run_failed'; error: unknown }

type SoftDeletePurgeBatchContext = {
	dryRun: boolean
	legacyDryRun: boolean
	started: number
	budgetMs: number
	candidates: Array<SoftDeletePurgeCandidate>
	index: number
	scanned: number
	purged: number
	failed: number
	timeBudgetExhausted: boolean
	outcomes: Array<SoftDeletePurgeOutcome>
	failure: unknown
	error: unknown
}

async function notProvided(): Promise<never> {
	throw new Error('soft-delete purge actor was not provided')
}

function outcome(
	candidate: SoftDeletePurgeCandidate,
	kind: SoftDeletePurgeOutcome['outcome'],
	error?: string,
): SoftDeletePurgeOutcome {
	return {
		kind: candidate.kind,
		id: candidate.id,
		ageDays: candidate.ageDays,
		outcome: kind,
		...(candidate.legacy ? { legacy: true as const } : {}),
		...(error === undefined ? {} : { error }),
	}
}

function settle(
	context: SoftDeletePurgeBatchContext,
	recorded: SoftDeletePurgeOutcome,
	patch: Partial<SoftDeletePurgeBatchContext> = {},
): SoftDeletePurgeBatchContext {
	return {
		...context,
		...patch,
		index: context.index + 1,
		outcomes: [...context.outcomes, recorded],
	}
}

/**
 * One soft-delete purge batch. Every live candidate is claimed before its
 * hard purge, the time budget is checked before each claim, and a failed
 * claim or purge is recorded with its failure audit before the next candidate.
 * A candidate that exhausted its transient D1 retry budget is recorded with
 * its own audit and keeps its claim.
 */
export const softDeletePurgeBatchState = setup({
	schemas: {
		input: types<{
			dryRun: boolean
			legacyDryRun: boolean
			started: number
			budgetMs: number
		}>(),
		context: types<SoftDeletePurgeBatchContext>(),
		output: types<SoftDeletePurgeBatchOutput>(),
	},
	actors: {
		listCandidates: createAsyncLogic<{
			scanned: number
			candidates: Array<SoftDeletePurgeCandidate>
		}>({ run: notProvided }),
		readClock: createAsyncLogic<number>({ run: notProvided }),
		claimCandidate: createAsyncLogic<boolean, SoftDeletePurgeCandidate>({
			run: notProvided,
		}),
		purgeOrg: createAsyncLogic<void, SoftDeletePurgeCandidate>({
			run: notProvided,
		}),
		finishLegacyUser: createAsyncLogic<void, SoftDeletePurgeCandidate>({
			run: notProvided,
		}),
		purgeUser: createAsyncLogic<void, SoftDeletePurgeCandidate>({
			run: notProvided,
		}),
		recordFailure: createAsyncLogic<
			string,
			{ candidate: SoftDeletePurgeCandidate; error: unknown }
		>({ run: notProvided }),
		recordRetryBudgetExhausted: createAsyncLogic<
			string,
			{
				candidate: SoftDeletePurgeCandidate
				error: TransientRetryBudgetExhausted
			}
		>({ run: notProvided }),
	},
	guards: {
		hasNextCandidate: (context: SoftDeletePurgeBatchContext) =>
			context.index < context.candidates.length,
		isPreviewCandidate: (context: SoftDeletePurgeBatchContext) =>
			context.candidates[context.index]!.legacy
				? context.legacyDryRun
				: context.dryRun,
		budgetExceeded: (context: SoftDeletePurgeBatchContext, now: number) =>
			now - context.started > context.budgetMs,
		isOrg: (candidate: SoftDeletePurgeCandidate) => candidate.kind === 'org',
		isLegacyUser: (candidate: SoftDeletePurgeCandidate) =>
			candidate.legacy === true,
		missingDbUserId: (candidate: SoftDeletePurgeCandidate) =>
			candidate.dbUserId == null,
		claimRefused: (claimed: boolean) => !claimed,
		retryBudgetExhausted: (error: unknown) =>
			error instanceof TransientRetryBudgetExhausted,
	},
}).createMachine({
	id: 'soft_delete_purge.batch',
	description:
		'Lists candidates, previews dry-run ones, and for each live one checks the budget, claims it, runs the org, legacy-user or user hard purge, and records success, a failure audit, or a retry-budget-exhausted audit before moving on; a failed listing or failure audit fails the run.',
	context: ({ input }) => ({
		...input,
		candidates: [],
		index: 0,
		scanned: 0,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [],
		failure: undefined,
		error: undefined,
	}),
	initial: 'listing',
	states: {
		listing: {
			invoke: {
				src: 'listCandidates',
				onDone: ({ context, event }) => ({
					target: 'advancing',
					context: {
						...context,
						scanned: event.output.scanned,
						candidates: event.output.candidates,
					},
				}),
				onError: ({ context, event }) => ({
					target: 'run_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		advancing: {
			always: ({ context, guards }) => {
				if (!guards.hasNextCandidate(context)) return { target: 'completed' }
				if (guards.isPreviewCandidate(context))
					return {
						target: 'advancing',
						context: settle(
							context,
							outcome(context.candidates[context.index]!, 'would_purge'),
						),
					}
				return { target: 'checking_budget' }
			},
		},
		checking_budget: {
			invoke: {
				src: 'readClock',
				onDone: ({ context, event, guards }) => {
					if (guards.budgetExceeded(context, event.output))
						return {
							target: 'completed',
							context: { ...context, timeBudgetExhausted: true },
						}
					return { target: 'claiming' }
				},
				onError: ({ context, event }) => ({
					target: 'run_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		claiming: {
			invoke: {
				src: 'claimCandidate',
				input: ({ context }) => context.candidates[context.index]!,
				onDone: ({ context, event, guards }) => {
					const candidate = context.candidates[context.index]!
					if (guards.claimRefused(event.output))
						return {
							target: 'advancing',
							context: settle(context, outcome(candidate, 'skipped_claim')),
						}
					if (guards.isOrg(candidate)) return { target: 'purging_org' }
					if (guards.missingDbUserId(candidate))
						return {
							target: 'recording_failure',
							context: {
								...context,
								failure: new Error(`user_purge_missing_db_id:${candidate.id}`),
							},
						}
					if (guards.isLegacyUser(candidate))
						return { target: 'finishing_legacy_user' }
					return { target: 'purging_user' }
				},
				onError: ({ context, event, guards }) => {
					if (guards.retryBudgetExhausted(event.error))
						return {
							target: 'recording_retry_budget_exhausted',
							context: { ...context, failure: event.error },
						}
					return {
						target: 'recording_failure',
						context: { ...context, failure: event.error },
					}
				},
			},
		},
		purging_org: {
			invoke: {
				src: 'purgeOrg',
				input: ({ context }) => context.candidates[context.index]!,
				onDone: ({ context }) => ({
					target: 'advancing',
					context: settle(
						context,
						outcome(context.candidates[context.index]!, 'purged'),
						{ purged: context.purged + 1 },
					),
				}),
				onError: ({ context, event, guards }) => {
					if (guards.retryBudgetExhausted(event.error))
						return {
							target: 'recording_retry_budget_exhausted',
							context: { ...context, failure: event.error },
						}
					return {
						target: 'recording_failure',
						context: { ...context, failure: event.error },
					}
				},
			},
		},
		finishing_legacy_user: {
			invoke: {
				src: 'finishLegacyUser',
				input: ({ context }) => context.candidates[context.index]!,
				onDone: ({ context }) => ({
					target: 'advancing',
					context: settle(
						context,
						outcome(context.candidates[context.index]!, 'purged'),
						{ purged: context.purged + 1 },
					),
				}),
				onError: ({ context, event, guards }) => {
					if (guards.retryBudgetExhausted(event.error))
						return {
							target: 'recording_retry_budget_exhausted',
							context: { ...context, failure: event.error },
						}
					return {
						target: 'recording_failure',
						context: { ...context, failure: event.error },
					}
				},
			},
		},
		purging_user: {
			invoke: {
				src: 'purgeUser',
				input: ({ context }) => context.candidates[context.index]!,
				onDone: ({ context }) => ({
					target: 'advancing',
					context: settle(
						context,
						outcome(context.candidates[context.index]!, 'purged'),
						{ purged: context.purged + 1 },
					),
				}),
				onError: ({ context, event, guards }) => {
					if (guards.retryBudgetExhausted(event.error))
						return {
							target: 'recording_retry_budget_exhausted',
							context: { ...context, failure: event.error },
						}
					return {
						target: 'recording_failure',
						context: { ...context, failure: event.error },
					}
				},
			},
		},
		recording_failure: {
			invoke: {
				src: 'recordFailure',
				input: ({ context }) => ({
					candidate: context.candidates[context.index]!,
					error: context.failure,
				}),
				onDone: ({ context, event }) => ({
					target: 'advancing',
					context: settle(
						context,
						outcome(context.candidates[context.index]!, 'failed', event.output),
						{ failed: context.failed + 1, failure: undefined },
					),
				}),
				onError: ({ context, event }) => ({
					target: 'run_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		recording_retry_budget_exhausted: {
			invoke: {
				src: 'recordRetryBudgetExhausted',
				input: ({ context }) => ({
					candidate: context.candidates[context.index]!,
					error: context.failure as TransientRetryBudgetExhausted,
				}),
				onDone: ({ context, event }) => ({
					target: 'advancing',
					context: settle(
						context,
						outcome(context.candidates[context.index]!, 'failed', event.output),
						{ failed: context.failed + 1, failure: undefined },
					),
				}),
				onError: ({ context, event }) => ({
					target: 'run_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		completed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'completed' as const,
				scanned: context.scanned,
				purged: context.purged,
				failed: context.failed,
				timeBudgetExhausted: context.timeBudgetExhausted,
				outcomes: context.outcomes,
			}),
		},
		run_failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'run_failed' as const,
				error: context.error,
			}),
		},
	},
})
