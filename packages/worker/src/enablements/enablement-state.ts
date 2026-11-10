import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const enablementState = setup({
	types: {
		events: {} as { type: 'PAUSE' } | { type: 'DISABLE' } | { type: 'RESUME' },
	},
}).createMachine({
	id: 'enablements.state',
	description:
		'Enablements start on, pause or rewrite a pause cause, resume after access recovers, and turn off permanently.',
	initial: 'on',
	states: {
		on: { on: { PAUSE: 'paused', DISABLE: 'off' } },
		paused: { on: { PAUSE: 'paused', RESUME: 'on', DISABLE: 'off' } },
		off: { type: 'final' },
	},
})
export type EnablementState = LifecycleStateOf<typeof enablementState>
