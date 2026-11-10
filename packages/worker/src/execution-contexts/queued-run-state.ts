import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const queuedRunState = setup({
	schemas: {
		events: {
			START_HANDOFF: types<{}>(),
			FINISH: types<{}>(),
			CANCEL: types<{}>(),
			EXPIRE: types<{}>(),
			RELEASE_HANDOFF: types<{}>(),
		},
	},
}).createMachine({
	id: 'execution_context_queued.lifecycle',
	description:
		'Queued rows enter a starting handoff that always releases its cancellation fence, then retry or leave the queue after dispatch, cancellation, failure or expiry.',
	initial: 'queued',
	states: {
		queued: {
			on: {
				START_HANDOFF: { target: 'starting' },
				FINISH: { target: 'finished' },
				CANCEL: { target: 'cancelled' },
				EXPIRE: { target: 'expired' },
			},
		},
		starting: {
			on: {
				RELEASE_HANDOFF: { target: 'queued' },
				FINISH: { target: 'finished' },
				EXPIRE: { target: 'expired' },
			},
		},
		finished: { type: 'final' },
		cancelled: { type: 'final' },
		expired: { type: 'final' },
	},
})

export type QueuedRunState = LifecycleStateOf<typeof queuedRunState>
