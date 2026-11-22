import { createAsyncLogic, setup, types } from 'xstate'

export type GuestPurgeRow = {
	id: number
	stable_user_id: string
	personal_org_id: string | null
	username: string
	email: string
	guest_created_at: string
}

export type GuestPurgeResult = {
	scanned: number
	purged: number
	failed: number
}

export type GuestPurgeOutput =
	| { status: 'completed'; result: GuestPurgeResult }
	| { status: 'list_failed'; error: unknown }

type GuestPurgeContext = {
	now: string
	batchSize: number
	rows: Array<GuestPurgeRow>
	index: number
	result: GuestPurgeResult
	error: unknown
}

async function notProvided(): Promise<never> {
	throw new Error('guest purge actor was not provided')
}

/**
 * One guest purge batch. Each guest runs account deletion, then guest row
 * deletion, then the user-deleted announcement, and any failure moves on to
 * the next guest with the failure counted. A guest row whose account deletion
 * finished but whose own delete failed is no longer listed (the listing joins
 * users), so the batch ends by sweeping those rows.
 */
export const guestPurgeState = setup({
	schemas: {
		input: types<{ now: string; batchSize: number }>(),
		context: types<GuestPurgeContext>(),
		output: types<GuestPurgeOutput>(),
	},
	actors: {
		listExpiredGuests: createAsyncLogic<
			Array<GuestPurgeRow>,
			{ now: string; batchSize: number }
		>({ run: notProvided }),
		deleteGuestAccount: createAsyncLogic<void, GuestPurgeRow>({
			run: notProvided,
		}),
		deleteGuestRow: createAsyncLogic<void, GuestPurgeRow>({
			run: notProvided,
		}),
		announceGuestPurged: createAsyncLogic<void, GuestPurgeRow>({
			run: notProvided,
		}),
		deleteOrphanedGuestRows: createAsyncLogic<void, { now: string }>({
			run: notProvided,
		}),
	},
	guards: {
		hasNextGuest: (context: GuestPurgeContext) =>
			context.index < context.rows.length,
	},
}).createMachine({
	id: 'guest_purge.batch',
	description:
		'Lists expired unclaimed guests, then deletes each account before its guest row and announces only after both deletes; a failed guest is counted and the batch moves on, the batch ends by deleting expired unclaimed guest rows whose account is already gone, and a failed listing fails the lane.',
	context: ({ input }) => ({
		now: input.now,
		batchSize: input.batchSize,
		rows: [],
		index: 0,
		result: { scanned: 0, purged: 0, failed: 0 },
		error: undefined,
	}),
	initial: 'listing',
	states: {
		listing: {
			invoke: {
				src: 'listExpiredGuests',
				input: ({ context }) => ({
					now: context.now,
					batchSize: context.batchSize,
				}),
				onDone: ({ context, event }) => ({
					target: 'advancing',
					context: {
						...context,
						rows: event.output,
						result: { ...context.result, scanned: event.output.length },
					},
				}),
				onError: ({ context, event }) => ({
					target: 'list_failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		advancing: {
			always: ({ context, guards }) => {
				if (guards.hasNextGuest(context)) return { target: 'deleting_account' }
				return { target: 'sweeping_orphaned_guest_rows' }
			},
		},
		deleting_account: {
			invoke: {
				src: 'deleteGuestAccount',
				input: ({ context }) => context.rows[context.index]!,
				onDone: { target: 'deleting_guest_row' },
				onError: ({ context, event }, enq) => {
					enq(() =>
						console.error('guest_account_purge_failed', { error: event.error }),
					)
					return {
						target: 'advancing',
						context: {
							...context,
							index: context.index + 1,
							result: { ...context.result, failed: context.result.failed + 1 },
						},
					}
				},
			},
		},
		deleting_guest_row: {
			invoke: {
				src: 'deleteGuestRow',
				input: ({ context }) => context.rows[context.index]!,
				onDone: ({ context }) => ({
					target: 'announcing',
					context: {
						...context,
						result: { ...context.result, purged: context.result.purged + 1 },
					},
				}),
				onError: ({ context, event }, enq) => {
					enq(() =>
						console.error('guest_account_purge_failed', { error: event.error }),
					)
					return {
						target: 'advancing',
						context: {
							...context,
							index: context.index + 1,
							result: { ...context.result, failed: context.result.failed + 1 },
						},
					}
				},
			},
		},
		announcing: {
			invoke: {
				src: 'announceGuestPurged',
				input: ({ context }) => context.rows[context.index]!,
				onDone: ({ context }) => ({
					target: 'advancing',
					context: { ...context, index: context.index + 1 },
				}),
				onError: ({ context, event }, enq) => {
					enq(() =>
						console.error('guest_account_purge_failed', { error: event.error }),
					)
					return {
						target: 'advancing',
						context: {
							...context,
							index: context.index + 1,
							result: { ...context.result, failed: context.result.failed + 1 },
						},
					}
				},
			},
		},
		sweeping_orphaned_guest_rows: {
			invoke: {
				src: 'deleteOrphanedGuestRows',
				input: ({ context }) => ({ now: context.now }),
				onDone: { target: 'completed' },
				onError: ({ event }, enq) => {
					enq(() =>
						console.error('guest_account_orphan_sweep_failed', {
							error: event.error,
						}),
					)
					return { target: 'completed' }
				},
			},
		},
		completed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'completed' as const,
				result: context.result,
			}),
		},
		list_failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'list_failed' as const,
				error: context.error,
			}),
		},
	},
})
