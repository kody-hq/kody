import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import type { OrgAuditOutboxPayload } from './org-audit-outbox.ts'
import {
	type OrgAuditOutboxDrainRow,
	orgAuditOutboxDeliveryState,
	orgAuditOutboxDrainState,
} from './org-audit-outbox-state.ts'

const payload = { id: 'audit-1' } as unknown as OrgAuditOutboxPayload

function deliver(steps: {
	read?: () => Promise<OrgAuditOutboxPayload | 'row_gone'>
	insert?: () => Promise<'inserted' | 'already_exists'>
	emit?: () => Promise<void>
	clear?: () => Promise<void>
}) {
	const calls: Array<string> = []
	function step<T>(name: string, body: () => Promise<T>) {
		return createAsyncLogic({
			run: async () => {
				calls.push(name)
				return body()
			},
		})
	}
	const machine = orgAuditOutboxDeliveryState.provide({
		actors: {
			readLivePayload: step('read', steps.read ?? (async () => payload)),
			insertAuditRow: step(
				'insert',
				steps.insert ?? (async () => 'inserted' as const),
			),
			emitResourceChange: step('emit', steps.emit ?? (async () => {})),
			clearOutboxRow: step('clear', steps.clear ?? (async () => {})),
		},
	})
	return { calls, output: toPromise(createActor(machine).start()) }
}

test('a newly inserted audit row emits its event before the outbox row is cleared', async () => {
	const { calls, output } = deliver({})
	expect(await output).toBe(true)
	expect(calls).toEqual(['read', 'insert', 'emit', 'clear'])
})

test('a failed clear after emitting reports the row undelivered for a quiet retry', async () => {
	const first = deliver({
		clear: async () => {
			throw new Error('D1 down')
		},
	})
	expect(await first.output).toBe(false)
	expect(first.calls).toEqual(['read', 'insert', 'emit', 'clear'])
	const retry = deliver({ insert: async () => 'already_exists' as const })
	expect(await retry.output).toBe(true)
	expect(retry.calls).toEqual(['read', 'insert', 'clear'])
})

test('emit failures still clear the row; read and insert failures keep it', async () => {
	const emitFails = deliver({
		emit: async () => {
			throw new Error('queue down')
		},
	})
	expect(await emitFails.output).toBe(true)
	expect(emitFails.calls).toEqual(['read', 'insert', 'emit', 'clear'])
	const insertFails = deliver({
		insert: async () => {
			throw new Error('audit down')
		},
	})
	expect(await insertFails.output).toBe(false)
	expect(insertFails.calls).toEqual(['read', 'insert'])
	const gone = deliver({ read: async () => 'row_gone' as const })
	expect(await gone.output).toBe(true)
	expect(gone.calls).toEqual(['read'])
})

function row(id: string): OrgAuditOutboxDrainRow {
	return { id, payload_json: '{}', created_at: '2026-11-22T15:00:00.000Z' }
}

function drain(input: {
	auditConfigured?: boolean
	batches: Array<Array<OrgAuditOutboxDrainRow>>
	clock?: Array<number>
	results?: Record<string, 'delivered' | 'not_delivered' | 'invalid_payload'>
	batchLimit?: number
}) {
	const delivered: Array<string> = []
	const clock = [...(input.clock ?? [])]
	const batches = [...input.batches]
	const machine = orgAuditOutboxDrainState.provide({
		actors: {
			readClock: createAsyncLogic({ run: async () => clock.shift() ?? 0 }),
			listBatch: createAsyncLogic({ run: async () => batches.shift() ?? [] }),
			deliverRow: createAsyncLogic({
				run: async ({ input: next }: { input: OrgAuditOutboxDrainRow }) => {
					delivered.push(next.id)
					return input.results?.[next.id] ?? ('delivered' as const)
				},
			}),
			countRemaining: createAsyncLogic({ run: async () => 7 }),
		},
	})
	const output = toPromise(
		createActor(machine, {
			input: {
				auditConfigured: input.auditConfigured ?? true,
				deadline: 100,
				batchLimit: input.batchLimit ?? 2,
			},
		}).start(),
	)
	return { delivered, output }
}

test('a drain without AUDIT_DB is skipped before any read', async () => {
	const { delivered, output } = drain({
		auditConfigured: false,
		batches: [[row('a')]],
	})
	expect(await output).toEqual({
		status: 'skipped',
		reason: 'audit_db_unconfigured',
	})
	expect(delivered).toEqual([])
})

test('a drain stops at its time budget and still counts what remains', async () => {
	const { delivered, output } = drain({
		batches: [[row('a'), row('b')]],
		clock: [0, 0, 100],
	})
	expect(await output).toMatchObject({
		status: 'ok',
		delivered: 1,
		remaining: 7,
	})
	expect(delivered).toEqual(['a'])
})

test('a full batch reads the next batch, and an invalid payload is logged and counted', async () => {
	consoleError.mockImplementation(() => {})
	const { delivered, output } = drain({
		batches: [[row('a'), row('b')], [row('c')]],
		results: { b: 'invalid_payload' },
	})
	expect(await output).toMatchObject({ status: 'ok', delivered: 2, errors: 1 })
	expect(delivered).toEqual(['a', 'b', 'c'])
	expect(consoleError).toHaveBeenCalledWith(
		'org_audit_outbox_invalid_payload',
		{
			id: 'b',
		},
	)
})
