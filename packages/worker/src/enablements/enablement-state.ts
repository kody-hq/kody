import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const enablementState = setup({
	schemas: {
		events: { PAUSE: types<{}>(), DISABLE: types<{}>(), RESUME: types<{}>() },
	},
}).createMachine({
	id: 'enablements.state',
	description:
		'Enablements start on, pause or rewrite a pause cause, resume after access recovers, and turn off permanently.',
	initial: 'on',
	states: {
		on: { on: { PAUSE: { target: 'paused' }, DISABLE: { target: 'off' } } },
		paused: {
			on: {
				PAUSE: { target: 'paused' },
				RESUME: { target: 'on' },
				DISABLE: { target: 'off' },
			},
		},
		off: { type: 'final' },
	},
})
export type EnablementState = LifecycleStateOf<typeof enablementState>
