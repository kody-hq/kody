import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inboundDedupePointerState = setup({
	schemas: { events: { RESET_WINDOW: types<{}>(), TOMBSTONE: types<{}>() } },
}).createMachine({
	id: 'email_inbound_dedupe_pointer.state',
	description:
		'Dedupe windows start pending, tombstone on message deletion, and reset after expiry; repeat tombstones are idempotent.',
	initial: 'pending',
	states: {
		pending: {
			on: {
				RESET_WINDOW: { target: 'pending' },
				TOMBSTONE: { target: 'rejected' },
			},
		},
		rejected: {
			on: {
				RESET_WINDOW: { target: 'pending' },
				TOMBSTONE: { target: 'rejected' },
			},
		},
	},
})
export type InboundDedupePointerState = LifecycleStateOf<
	typeof inboundDedupePointerState
>
