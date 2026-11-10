import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const hostCommandState = setup({
	types: {
		events: {} as
			| { type: 'TIMEOUT' }
			| { type: 'SPAWN_ERROR' }
			| { type: 'EXIT' }
			| { type: 'KILL' },
	},
}).createMachine({
	id: 'host_background_command.state',
	description:
		'Background commands exit, time out, kill or fail; a spawn error can finish a command already stopped by timeout or kill.',
	initial: 'running',
	states: {
		running: {
			on: {
				TIMEOUT: 'timed_out',
				SPAWN_ERROR: 'failed',
				EXIT: 'exited',
				KILL: 'killed',
			},
		},
		exited: { type: 'final' },
		killed: { on: { SPAWN_ERROR: 'failed' } },
		timed_out: { on: { SPAWN_ERROR: 'failed' } },
		failed: { type: 'final' },
	},
})
export type HostCommandState = LifecycleStateOf<typeof hostCommandState>
