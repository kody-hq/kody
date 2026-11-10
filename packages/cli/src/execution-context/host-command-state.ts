import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const hostCommandState = setup({
	schemas: {
		events: {
			TIMEOUT: types<{}>(),
			SPAWN_ERROR: types<{}>(),
			EXIT: types<{}>(),
			KILL: types<{}>(),
		},
	},
}).createMachine({
	id: 'host_background_command.state',
	description:
		'Background commands exit, time out, kill or fail; a spawn error can finish a command already stopped by timeout or kill.',
	initial: 'running',
	states: {
		running: {
			on: {
				TIMEOUT: { target: 'timed_out' },
				SPAWN_ERROR: { target: 'failed' },
				EXIT: { target: 'exited' },
				KILL: { target: 'killed' },
			},
		},
		exited: { type: 'final' },
		killed: { on: { SPAWN_ERROR: { target: 'failed' } } },
		timed_out: { on: { SPAWN_ERROR: { target: 'failed' } } },
		failed: { type: 'final' },
	},
})
/**
 * Background host-command lifecycle. `killed` and `timed_out` are not final: a
 * late spawn error can still move them to `failed`.
 */
export type HostCommandState = LifecycleStateOf<typeof hostCommandState>
