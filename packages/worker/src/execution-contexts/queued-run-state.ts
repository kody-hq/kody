import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const queuedRunState = setup({
	types: {
		events: {} as
			| { type: 'START_HANDOFF' }
			| { type: 'FINISH' }
			| { type: 'CANCEL' }
			| { type: 'EXPIRE' }
			| { type: 'RELEASE_HANDOFF' },
	},
}).createMachine({
	id: 'execution_context_queued.lifecycle',
	description:
		'Queued rows enter a starting handoff that always releases its cancellation fence, then retry or leave the queue after dispatch, cancellation, failure or expiry.',
	initial: 'queued',
	states: {
		queued: {
			on: {
				START_HANDOFF: 'starting',
				FINISH: 'finished',
				CANCEL: 'cancelled',
				EXPIRE: 'expired',
			},
		},
		starting: {
			on: { RELEASE_HANDOFF: 'queued', FINISH: 'finished', EXPIRE: 'expired' },
		},
		finished: { type: 'final' },
		cancelled: { type: 'final' },
		expired: { type: 'final' },
	},
})

export type QueuedRunState = LifecycleStateOf<typeof queuedRunState>
