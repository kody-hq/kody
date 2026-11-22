import { finalStatesOf } from '@kody-internal/shared/state-machine.ts'
import { createActor, createAsyncLogic, toPromise } from 'xstate'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { type GuestPurgeRow, guestPurgeState } from './guest-purge-state.ts'

function guest(id: number): GuestPurgeRow {
	return {
		id,
		stable_user_id: `person-${id}`,
		personal_org_id: null,
		username: `guest-${id}`,
		email: `guest-${id}@example.com`,
		guest_created_at: '2026-11-01T00:00:00.000Z',
	}
}

function purge(input: {
	rows?: Array<GuestPurgeRow>
	list?: () => Promise<Array<GuestPurgeRow>>
	failAccount?: number
	failGuestRow?: number
	failSweep?: boolean
}) {
	const calls: Array<string> = []
	function step(name: string, fail?: number) {
		return createAsyncLogic({
			run: async ({ input: row }: { input: GuestPurgeRow }) => {
				calls.push(`${name}:${row.id}`)
				if (row.id === fail) throw new Error(`${name} failed`)
			},
		})
	}
	const machine = guestPurgeState.provide({
		actors: {
			listExpiredGuests: createAsyncLogic({
				run: input.list ?? (async () => input.rows ?? []),
			}),
			deleteGuestAccount: step('account', input.failAccount),
			deleteGuestRow: step('guest_row', input.failGuestRow),
			announceGuestPurged: step('announce'),
			deleteOrphanedGuestRows: createAsyncLogic({
				run: async () => {
					calls.push('sweep')
					if (input.failSweep) throw new Error('sweep failed')
				},
			}),
		},
	})
	const output = toPromise(
		createActor(machine, {
			input: { now: '2026-11-22T15:00:00.000Z', batchSize: 50 },
		}).start(),
	)
	return { calls, output }
}

test('a guest purge batch ends in completed or list_failed only', () => {
	expect([...finalStatesOf(guestPurgeState)].sort()).toEqual([
		'completed',
		'list_failed',
	])
})

test('each guest deletes its account, then its guest row, then announces, and the batch ends with the orphan sweep', async () => {
	const { calls, output } = purge({ rows: [guest(1), guest(2)] })
	expect(await output).toEqual({
		status: 'completed',
		result: { scanned: 2, purged: 2, failed: 0 },
	})
	expect(calls).toEqual([
		'account:1',
		'guest_row:1',
		'announce:1',
		'account:2',
		'guest_row:2',
		'announce:2',
		'sweep',
	])
})

test('a failed guest is counted and skips its later steps while the batch continues', async () => {
	consoleError.mockImplementation(() => {})
	const { calls, output } = purge({
		rows: [guest(1), guest(2), guest(3)],
		failAccount: 1,
		failGuestRow: 2,
	})
	expect(await output).toEqual({
		status: 'completed',
		result: { scanned: 3, purged: 1, failed: 2 },
	})
	expect(calls).toEqual([
		'account:1',
		'account:2',
		'guest_row:2',
		'account:3',
		'guest_row:3',
		'announce:3',
		'sweep',
	])
})

test('a failed listing fails the batch, and a failed sweep still completes it', async () => {
	const listError = new Error('D1 down')
	const listing = purge({
		list: async () => {
			throw listError
		},
	})
	expect(await listing.output).toEqual({
		status: 'list_failed',
		error: listError,
	})
	expect(listing.calls).toEqual([])
	consoleError.mockImplementation(() => {})
	const sweeping = purge({ rows: [], failSweep: true })
	expect(await sweeping.output).toMatchObject({ status: 'completed' })
	expect(consoleError).toHaveBeenCalledWith(
		'guest_account_orphan_sweep_failed',
		expect.anything(),
	)
})
