import { createAsyncLogic, setup, types } from 'xstate'
import type {
	OAuthPurgeResult,
	PurgeContinuation,
} from '#worker/oauth-purge.ts'

async function notProvided(): Promise<never> {
	throw new Error('oauth purge actor was not provided')
}

type PhaseOutput = { result: OAuthPurgeResult; continuation: PurgeContinuation }

type OAuthPurgeRunContext = {
	continuation: PurgeContinuation | null
	result: OAuthPurgeResult | null
	error: unknown
}

export type OAuthPurgeRunOutput =
	| { status: 'saved'; result: OAuthPurgeResult }
	| { status: 'failed'; error: unknown }

/**
 * One OAuth purge run. The continuation is loaded from Durable Object
 * storage, one phase advances it within the run budget, and only a phase
 * that finished is saved; a failed step leaves the stored continuation as it
 * was so the next run repeats the unsaved work.
 */
export const oauthPurgeRunState = setup({
	schemas: {
		context: types<OAuthPurgeRunContext>(),
		output: types<OAuthPurgeRunOutput>(),
	},
	actors: {
		loadContinuation: createAsyncLogic<PurgeContinuation>({ run: notProvided }),
		purgeGrantPhase: createAsyncLogic<PhaseOutput, PurgeContinuation>({
			run: notProvided,
		}),
		purgeTokenPhase: createAsyncLogic<PhaseOutput, PurgeContinuation>({
			run: notProvided,
		}),
		saveContinuation: createAsyncLogic<void, PurgeContinuation>({
			run: notProvided,
		}),
	},
	guards: {
		resumesGrantPhase: (continuation: PurgeContinuation) =>
			continuation.nextPhase === 'grants',
	},
}).createMachine({
	id: 'oauth_purge.run',
	description:
		'Loads the stored continuation, runs its next grant or token phase, then saves the advanced continuation; a failed load, phase or save ends the run without saving.',
	context: { continuation: null, result: null, error: undefined },
	initial: 'loading_continuation',
	states: {
		loading_continuation: {
			invoke: {
				src: 'loadContinuation',
				onDone: ({ context, event, guards }) => {
					const next = { ...context, continuation: event.output }
					if (guards.resumesGrantPhase(event.output))
						return { target: 'purging_grants', context: next }
					return { target: 'purging_tokens', context: next }
				},
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		purging_grants: {
			invoke: {
				src: 'purgeGrantPhase',
				input: ({ context }) => context.continuation!,
				onDone: ({ context, event }) => ({
					target: 'saving_continuation',
					context: { ...context, ...event.output },
				}),
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		purging_tokens: {
			invoke: {
				src: 'purgeTokenPhase',
				input: ({ context }) => context.continuation!,
				onDone: ({ context, event }) => ({
					target: 'saving_continuation',
					context: { ...context, ...event.output },
				}),
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		saving_continuation: {
			invoke: {
				src: 'saveContinuation',
				input: ({ context }) => context.continuation!,
				onDone: { target: 'saved' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		saved: {
			type: 'final',
			output: ({ context }) => ({
				status: 'saved' as const,
				result: context.result!,
			}),
		},
		failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'failed' as const,
				error: context.error,
			}),
		},
	},
})

export type OAuthPurgeRunRequest = {
	scheduledAt: number
	resolve: (result: OAuthPurgeResult) => void
	reject: (error: unknown) => void
}

type CoordinatorContext = {
	current: OAuthPurgeRunRequest | null
	queue: Array<OAuthPurgeRunRequest>
}

/**
 * Serializes purge runs inside the coordinator Durable Object. A run requested
 * while another is active waits in order, and every request settles exactly
 * once with its own run's result or error.
 */
export const oauthPurgeCoordinatorState = setup({
	schemas: {
		context: types<CoordinatorContext>(),
		events: {
			RUN: types<{ request: OAuthPurgeRunRequest }>(),
		},
	},
	actors: {
		purgeRun: createAsyncLogic<OAuthPurgeResult, { scheduledAt: number }>({
			run: notProvided,
		}),
	},
	guards: {
		hasQueuedRun: (context: CoordinatorContext) => context.queue.length > 0,
	},
}).createMachine({
	id: 'oauth_purge.coordinator',
	description:
		'Idle until a run is requested; a running coordinator queues later requests and starts the next queued run after the current one succeeds or fails.',
	context: { current: null, queue: [] },
	initial: 'idle',
	states: {
		idle: {
			on: {
				RUN: ({ event }) => ({
					target: 'running',
					context: { current: event.request, queue: [] },
				}),
			},
		},
		running: {
			on: {
				RUN: ({ context, event }) => ({
					context: { ...context, queue: [...context.queue, event.request] },
				}),
			},
			invoke: {
				src: 'purgeRun',
				input: ({ context }) => ({ scheduledAt: context.current!.scheduledAt }),
				onDone: ({ context, event, guards }, enq) => {
					const settled = context.current!
					enq(() => settled.resolve(event.output))
					if (guards.hasQueuedRun(context))
						return {
							target: 'running',
							reenter: true,
							context: {
								current: context.queue[0]!,
								queue: context.queue.slice(1),
							},
						}
					return { target: 'idle', context: { current: null, queue: [] } }
				},
				onError: ({ context, event, guards }, enq) => {
					const settled = context.current!
					enq(() => settled.reject(event.error))
					if (guards.hasQueuedRun(context))
						return {
							target: 'running',
							reenter: true,
							context: {
								current: context.queue[0]!,
								queue: context.queue.slice(1),
							},
						}
					return { target: 'idle', context: { current: null, queue: [] } }
				},
			},
		},
	},
})
