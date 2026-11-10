import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const runDispatchState = setup({
	types: {
		events: {} as
			| { type: 'COMMIT' }
			| { type: 'ABORT' }
			| { type: 'REJECT' }
			| { type: 'SUCCEED' }
			| { type: 'FAIL' }
			| { type: 'CANCEL' }
			| { type: 'LOSE' }
			| { type: 'OFFER' },
	},
}).createMachine({
	id: 'execution_context_runs.state',
	description:
		'Dispatch offers commit or abort and rejected offers can retry; committed runs finish once, while the existing offer-failure setter can still abort or reject any nonfinal row.',
	initial: 'dispatched',
	states: {
		dispatched: {
			on: { COMMIT: 'committed', ABORT: 'aborted', REJECT: 'rejected' },
		},
		committed: {
			on: {
				SUCCEED: 'succeeded',
				FAIL: 'failed',
				CANCEL: 'cancelled',
				LOSE: 'lost',
				ABORT: 'aborted',
				REJECT: 'rejected',
			},
		},
		succeeded: { type: 'final' },
		failed: { type: 'final' },
		cancelled: { type: 'final' },
		lost: { type: 'final' },
		rejected: {
			on: { OFFER: 'dispatched', REJECT: 'rejected', ABORT: 'aborted' },
		},
		aborted: {
			on: { OFFER: 'dispatched', REJECT: 'rejected', ABORT: 'aborted' },
		},
	},
})

export type RunDispatchState = LifecycleStateOf<typeof runDispatchState>
