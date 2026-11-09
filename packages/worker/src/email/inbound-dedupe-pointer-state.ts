import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const inboundDedupePointerState = setup({
	types: {
		events: {} as { type: 'RESET_WINDOW' } | { type: 'TOMBSTONE' },
	},
}).createMachine({
	id: 'email_inbound_dedupe_pointer.state',
	description:
		'Dedupe windows start pending, tombstone on message deletion, and reset after expiry; repeat tombstones are idempotent.',
	initial: 'pending',
	states: {
		pending: { on: { RESET_WINDOW: 'pending', TOMBSTONE: 'rejected' } },
		rejected: { on: { RESET_WINDOW: 'pending', TOMBSTONE: 'rejected' } },
	},
})
export type InboundDedupePointerState = LifecycleStateOf<
	typeof inboundDedupePointerState
>
