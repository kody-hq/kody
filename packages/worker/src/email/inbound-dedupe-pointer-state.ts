import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const inboundDedupePointerState = defineStateMachine({
	name: 'email_inbound_dedupe_pointer.state',
	description:
		'Dedupe windows start pending, tombstone on message deletion, and reset after expiry; repeat tombstones are idempotent.',
	initial: 'pending',
	transitions: {
		pending: ['pending', 'rejected'],
		rejected: ['pending', 'rejected'],
	},
})
export type InboundDedupePointerState = StateOf<
	typeof inboundDedupePointerState
>
