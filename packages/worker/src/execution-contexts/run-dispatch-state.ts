import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const runDispatchState = defineStateMachine({
	name: 'execution_context_runs.state',
	description:
		'Dispatch offers commit or abort and rejected offers can retry; committed runs finish once, while the existing offer-failure setter can still abort or reject any nonfinal row.',
	initial: 'dispatched',
	transitions: {
		dispatched: ['committed', 'aborted', 'rejected'],
		committed: [
			'succeeded',
			'failed',
			'cancelled',
			'lost',
			'aborted',
			'rejected',
		],
		succeeded: [],
		failed: [],
		cancelled: [],
		lost: [],
		rejected: ['dispatched', 'rejected', 'aborted'],
		aborted: ['dispatched', 'rejected', 'aborted'],
	},
})

export type RunDispatchState = StateOf<typeof runDispatchState>
