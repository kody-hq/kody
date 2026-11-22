import { createAsyncLogic, setup, types } from 'xstate'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'

export type ScheduledLaneRunOutcome =
	| 'completed'
	| 'd1_lock_contention'
	| 'failed'

export type ScheduledLaneRunOutput =
	| { status: ScheduledLaneRunOutcome }
	| { status: 'report_failed'; error: unknown }

type ScheduledLaneRunInput = {
	lane: string
	scheduledTime: string
	/** Present only for lanes that hold a lease; absent lanes run unleased. */
	lease: { holder: string; leaseMs: number } | null
}

type ScheduledLaneRunContext = ScheduledLaneRunInput & {
	leaseHeld: boolean
	settled: ScheduledLaneRunOutcome | 'report_failed' | undefined
	error: unknown
}

async function notProvided(): Promise<never> {
	throw new Error('scheduled lane actor was not provided')
}

/**
 * One scheduled lane delivery with failure isolation. A leased lane acquires
 * its lease before running, and every path that acquired it passes through
 * `releasingLease` before settling, including a failed failure report.
 */
export const scheduledLaneRunState = setup({
	schemas: {
		input: types<ScheduledLaneRunInput>(),
		context: types<ScheduledLaneRunContext>(),
		output: types<ScheduledLaneRunOutput>(),
	},
	actors: {
		acquireLease: createAsyncLogic<
			boolean,
			{ lane: string; holder: string; leaseMs: number }
		>({ run: notProvided }),
		runLane: createAsyncLogic<void, { lane: string }>({ run: notProvided }),
		reportFailure: createAsyncLogic<void, { error: unknown }>({
			run: notProvided,
		}),
		releaseLease: createAsyncLogic<void, { lane: string; holder: string }>({
			run: notProvided,
		}),
	},
	guards: {
		isLeasedLane: (context: ScheduledLaneRunContext) => context.lease !== null,
		holdsLease: (context: ScheduledLaneRunContext) => context.leaseHeld,
		leaseAcquired: (acquired: boolean) => acquired,
		isD1LockContention: (error: unknown) => isRetryableD1LockError(error),
		settledCompleted: (context: ScheduledLaneRunContext) =>
			context.settled === 'completed',
		settledLockContention: (context: ScheduledLaneRunContext) =>
			context.settled === 'd1_lock_contention',
		settledFailed: (context: ScheduledLaneRunContext) =>
			context.settled === 'failed',
		settledReportFailed: (context: ScheduledLaneRunContext) =>
			context.settled === 'report_failed',
	},
}).createMachine({
	id: 'scheduled_lane.run',
	description:
		'Leased lanes acquire a lease or skip on overlap; the lane then runs, D1 lock contention settles without a report, other failures are reported, and a held lease is released before any outcome settles.',
	context: ({ input }) => ({
		...input,
		leaseHeld: false,
		settled: undefined,
		error: undefined,
	}),
	initial: 'deciding',
	states: {
		deciding: {
			always: ({ context, guards }) => {
				if (guards.isLeasedLane(context)) return { target: 'acquiring_lease' }
				return { target: 'running' }
			},
		},
		acquiring_lease: {
			invoke: {
				src: 'acquireLease',
				input: ({ context }) => ({ lane: context.lane, ...context.lease! }),
				onDone: ({ context, event, guards }, enq) => {
					if (guards.leaseAcquired(event.output))
						return {
							target: 'running',
							context: { ...context, leaseHeld: true },
						}
					enq(() =>
						console.warn('scheduled_lane_skipped_overlap', {
							lane: context.lane,
							scheduledTime: context.scheduledTime,
						}),
					)
					return { target: 'skipped_overlap' }
				},
				onError: ({ context, event, guards }, enq) => {
					if (guards.isD1LockContention(event.error)) {
						enq(() =>
							console.warn(
								`scheduled_lane_d1_lock_contention lane=${context.lane}`,
								event.error,
							),
						)
						return { target: 'lock_contention' }
					}
					return {
						target: 'reporting_failure',
						context: { ...context, error: event.error },
					}
				},
			},
		},
		running: {
			invoke: {
				src: 'runLane',
				input: ({ context }) => ({ lane: context.lane }),
				onDone: ({ context, guards }) => {
					if (guards.holdsLease(context))
						return {
							target: 'releasing_lease',
							context: { ...context, settled: 'completed' as const },
						}
					return { target: 'completed' }
				},
				onError: ({ context, event, guards }, enq) => {
					if (guards.isD1LockContention(event.error)) {
						enq(() =>
							console.warn(
								`scheduled_lane_d1_lock_contention lane=${context.lane}`,
								event.error,
							),
						)
						if (guards.holdsLease(context))
							return {
								target: 'releasing_lease',
								context: {
									...context,
									settled: 'd1_lock_contention' as const,
								},
							}
						return { target: 'lock_contention' }
					}
					return {
						target: 'reporting_failure',
						context: { ...context, error: event.error },
					}
				},
			},
		},
		reporting_failure: {
			invoke: {
				src: 'reportFailure',
				input: ({ context }) => ({ error: context.error }),
				onDone: ({ context, guards }) => {
					if (guards.holdsLease(context))
						return {
							target: 'releasing_lease',
							context: { ...context, settled: 'failed' as const },
						}
					return { target: 'failed' }
				},
				onError: ({ context, event, guards }) => {
					if (guards.holdsLease(context))
						return {
							target: 'releasing_lease',
							context: {
								...context,
								settled: 'report_failed' as const,
								error: event.error,
							},
						}
					return {
						target: 'report_failed',
						context: { ...context, error: event.error },
					}
				},
			},
		},
		releasing_lease: {
			invoke: {
				src: 'releaseLease',
				input: ({ context }) => ({
					lane: context.lane,
					holder: context.lease!.holder,
				}),
				onDone: ({ context, guards }) => {
					if (guards.settledCompleted(context)) return { target: 'completed' }
					if (guards.settledLockContention(context))
						return { target: 'lock_contention' }
					if (guards.settledReportFailed(context))
						return { target: 'report_failed' }
					return { target: 'failed' }
				},
				onError: ({ context, event, guards }, enq) => {
					enq(() =>
						console.warn('scheduled_lane_lease_release_failed', {
							lane: context.lane,
							error: event.error,
						}),
					)
					if (guards.settledCompleted(context)) return { target: 'completed' }
					if (guards.settledLockContention(context))
						return { target: 'lock_contention' }
					if (guards.settledReportFailed(context))
						return { target: 'report_failed' }
					return { target: 'failed' }
				},
			},
		},
		completed: { type: 'final', output: { status: 'completed' as const } },
		skipped_overlap: {
			type: 'final',
			output: { status: 'completed' as const },
		},
		lock_contention: {
			type: 'final',
			output: { status: 'd1_lock_contention' as const },
		},
		failed: { type: 'final', output: { status: 'failed' as const } },
		report_failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'report_failed' as const,
				error: context.error,
			}),
		},
	},
})
