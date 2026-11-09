import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const queuedRunState = defineStateMachine({
	name: 'execution_context_queued.lifecycle',
	description:
		'Queued rows enter a starting handoff that always releases its cancellation fence, then retry or leave the queue after dispatch, cancellation, failure or expiry.',
	initial: 'queued',
	transitions: {
		queued: ['starting', 'finished', 'cancelled', 'expired'],
		starting: ['queued', 'finished', 'expired'],
		finished: [],
		cancelled: [],
		expired: [],
	},
})

export type QueuedRunState = StateOf<typeof queuedRunState>
