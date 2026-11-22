import { createAsyncLogic, setup, types } from 'xstate'
import type { OrgAuditOutboxPayload } from '#worker/orgs/org-audit-outbox.ts'

export type OrgAuditOutboxDrainRow = {
	id: string
	payload_json: string
	created_at: string
}

export type OrgAuditOutboxDrainOutput =
	| {
			status: 'ok'
			delivered: number
			remaining: number
			errors: number
	  }
	| { status: 'skipped'; reason: 'audit_db_unconfigured' }
	| { status: 'drain_failed'; error: unknown }

type DrainCursor = { createdAt: string; id: string }

type DrainContext = {
	auditConfigured: boolean
	deadline: number
	batchLimit: number
	cursor: DrainCursor | null
	rows: Array<OrgAuditOutboxDrainRow>
	index: number
	delivered: number
	errors: number
	remaining: number
	error: unknown
}

type OrgAuditOutboxRowResult = 'delivered' | 'not_delivered' | 'invalid_payload'

async function notProvided(): Promise<never> {
	throw new Error('org audit outbox actor was not provided')
}

/**
 * Delivery of one outbox row into AUDIT_DB. The resource change event of a
 * newly inserted row is emitted before the outbox row is cleared, so a failed
 * clear leaves a row whose redelivery finds `already_exists` and stays quiet.
 */
export const orgAuditOutboxDeliveryState = setup({
	schemas: {
		context: types<{ payload: OrgAuditOutboxPayload | null }>(),
		output: types<boolean>(),
	},
	actors: {
		readLivePayload: createAsyncLogic<OrgAuditOutboxPayload | 'row_gone'>({
			run: notProvided,
		}),
		insertAuditRow: createAsyncLogic<
			'inserted' | 'already_exists',
			OrgAuditOutboxPayload
		>({ run: notProvided }),
		emitResourceChange: createAsyncLogic<void, OrgAuditOutboxPayload>({
			run: notProvided,
		}),
		clearOutboxRow: createAsyncLogic<void>({ run: notProvided }),
	},
	guards: {
		outboxRowGone: (
			payload: OrgAuditOutboxPayload | 'row_gone',
		): payload is 'row_gone' => payload === 'row_gone',
		auditRowInserted: (result: 'inserted' | 'already_exists') =>
			result === 'inserted',
	},
}).createMachine({
	id: 'org_audit_outbox.delivery',
	description:
		'Re-reads the live outbox payload, inserts it into AUDIT_DB, emits only for a new insert, and clears the outbox row last; any failure leaves the row for a later drain.',
	context: { payload: null },
	initial: 'reading_live',
	states: {
		reading_live: {
			invoke: {
				src: 'readLivePayload',
				onDone: ({ event, guards }) => {
					if (guards.outboxRowGone(event.output))
						return { target: 'already_cleared' }
					return { target: 'inserting', context: { payload: event.output } }
				},
				onError: { target: 'failed' },
			},
		},
		inserting: {
			invoke: {
				src: 'insertAuditRow',
				input: ({ context }) => context.payload!,
				onDone: ({ event, guards }) => {
					if (guards.auditRowInserted(event.output))
						return { target: 'emitting' }
					return { target: 'clearing' }
				},
				onError: { target: 'failed' },
			},
		},
		emitting: {
			invoke: {
				src: 'emitResourceChange',
				input: ({ context }) => context.payload!,
				onDone: { target: 'clearing' },
				onError: { target: 'clearing' },
			},
		},
		clearing: {
			invoke: {
				src: 'clearOutboxRow',
				onDone: { target: 'delivered' },
				onError: { target: 'failed' },
			},
		},
		delivered: { type: 'final', output: true },
		already_cleared: { type: 'final', output: true },
		failed: { type: 'final', output: false },
	},
})

/**
 * One scheduled outbox drain. Batches advance a cursor past every attempted
 * row, the time budget is checked before each batch and each row, and the
 * remaining count is read once the drain stops.
 */
export const orgAuditOutboxDrainState = setup({
	schemas: {
		input: types<{
			auditConfigured: boolean
			deadline: number
			batchLimit: number
		}>(),
		context: types<DrainContext>(),
		output: types<OrgAuditOutboxDrainOutput>(),
	},
	actors: {
		readClock: createAsyncLogic<number>({ run: notProvided }),
		listBatch: createAsyncLogic<
			Array<OrgAuditOutboxDrainRow>,
			{ cursor: DrainCursor | null; batchLimit: number }
		>({ run: notProvided }),
		deliverRow: createAsyncLogic<
			OrgAuditOutboxRowResult,
			OrgAuditOutboxDrainRow
		>({ run: notProvided }),
		countRemaining: createAsyncLogic<number>({ run: notProvided }),
	},
	guards: {
		hasAuditDb: (context: DrainContext) => context.auditConfigured,
		withinBudget: (context: DrainContext, now: number) =>
			now < context.deadline,
		hasNextRow: (context: DrainContext) => context.index < context.rows.length,
		batchWasFull: (context: DrainContext) =>
			context.rows.length >= context.batchLimit,
		batchEmpty: (rows: Array<OrgAuditOutboxDrainRow>) => rows.length === 0,
		rowDelivered: (result: OrgAuditOutboxRowResult) => result === 'delivered',
		rowPayloadInvalid: (result: OrgAuditOutboxRowResult) =>
			result === 'invalid_payload',
	},
}).createMachine({
	id: 'org_audit_outbox.drain',
	description:
		'Skips without AUDIT_DB; otherwise lists batches after a cursor while the budget lasts, delivers each row in order, counts malformed or undelivered rows as errors, and reports the remaining queue.',
	context: ({ input }) => ({
		...input,
		cursor: null,
		rows: [],
		index: 0,
		delivered: 0,
		errors: 0,
		remaining: 0,
		error: undefined,
	}),
	initial: 'deciding',
	states: {
		deciding: {
			always: ({ context, guards }) => {
				if (guards.hasAuditDb(context))
					return { target: 'checking_batch_budget' }
				return { target: 'skipped' }
			},
		},
		checking_batch_budget: {
			invoke: {
				src: 'readClock',
				onDone: ({ context, event, guards }) => {
					if (guards.withinBudget(context, event.output))
						return { target: 'listing' }
					return { target: 'counting' }
				},
				onError: ({ context, event }) => ({
					target: 'drain_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		listing: {
			invoke: {
				src: 'listBatch',
				input: ({ context }) => ({
					cursor: context.cursor,
					batchLimit: context.batchLimit,
				}),
				onDone: ({ context, event, guards }) => {
					if (guards.batchEmpty(event.output)) return { target: 'counting' }
					return {
						target: 'checking_row_budget',
						context: { ...context, rows: event.output, index: 0 },
					}
				},
				onError: ({ context, event }) => ({
					target: 'drain_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		checking_row_budget: {
			invoke: {
				src: 'readClock',
				onDone: ({ context, event, guards }) => {
					if (guards.withinBudget(context, event.output)) {
						const row = context.rows[context.index]!
						return {
							target: 'delivering',
							context: {
								...context,
								cursor: { createdAt: row.created_at, id: row.id },
							},
						}
					}
					return { target: 'batch_finished' }
				},
				onError: ({ context, event }) => ({
					target: 'drain_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		delivering: {
			invoke: {
				src: 'deliverRow',
				input: ({ context }) => context.rows[context.index]!,
				onDone: ({ context, event, guards }, enq) => {
					if (guards.rowDelivered(event.output))
						return {
							target: 'advancing',
							context: {
								...context,
								index: context.index + 1,
								delivered: context.delivered + 1,
							},
						}
					if (guards.rowPayloadInvalid(event.output)) {
						const id = context.rows[context.index]!.id
						enq(() => console.error('org_audit_outbox_invalid_payload', { id }))
					}
					return {
						target: 'advancing',
						context: {
							...context,
							index: context.index + 1,
							errors: context.errors + 1,
						},
					}
				},
				onError: ({ context, event }) => ({
					target: 'drain_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		advancing: {
			always: ({ context, guards }) => {
				if (guards.hasNextRow(context)) return { target: 'checking_row_budget' }
				return { target: 'batch_finished' }
			},
		},
		batch_finished: {
			always: ({ context, guards }) => {
				if (guards.batchWasFull(context))
					return { target: 'checking_batch_budget' }
				return { target: 'counting' }
			},
		},
		counting: {
			invoke: {
				src: 'countRemaining',
				onDone: ({ context, event }) => ({
					target: 'drained',
					context: { ...context, remaining: event.output },
				}),
				onError: ({ context, event }) => ({
					target: 'drain_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		drained: {
			type: 'final',
			output: ({ context }) => ({
				status: 'ok' as const,
				delivered: context.delivered,
				remaining: context.remaining,
				errors: context.errors,
			}),
		},
		skipped: {
			type: 'final',
			output: {
				status: 'skipped' as const,
				reason: 'audit_db_unconfigured' as const,
			},
		},
		drain_failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'drain_failed' as const,
				error: context.error,
			}),
		},
	},
})
