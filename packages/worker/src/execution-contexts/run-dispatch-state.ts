import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const runDispatchState = setup({
	schemas: {
		events: {
			COMMIT: types<{}>(),
			ABORT: types<{}>(),
			REJECT: types<{}>(),
			SUCCEED: types<{}>(),
			FAIL: types<{}>(),
			CANCEL: types<{}>(),
			LOSE: types<{}>(),
			OFFER: types<{}>(),
		},
	},
}).createMachine({
	id: 'execution_context_runs.state',
	description:
		'Dispatch offers commit or abort and rejected offers can retry; committed runs finish once, while the existing offer-failure setter can still abort or reject any nonfinal row.',
	initial: 'dispatched',
	states: {
		dispatched: {
			on: {
				COMMIT: { target: 'committed' },
				ABORT: { target: 'aborted' },
				REJECT: { target: 'rejected' },
			},
		},
		committed: {
			on: {
				SUCCEED: { target: 'succeeded' },
				FAIL: { target: 'failed' },
				CANCEL: { target: 'cancelled' },
				LOSE: { target: 'lost' },
				ABORT: { target: 'aborted' },
				REJECT: { target: 'rejected' },
			},
		},
		succeeded: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' },
		lost: { type: 'final' },
		rejected: {
			on: {
				OFFER: { target: 'dispatched' },
				REJECT: { target: 'rejected' },
				ABORT: { target: 'aborted' },
			},
		},
		aborted: {
			on: {
				OFFER: { target: 'dispatched' },
				REJECT: { target: 'rejected' },
				ABORT: { target: 'aborted' },
			},
		},
	},
})

export type RunDispatchState = LifecycleStateOf<typeof runDispatchState>
