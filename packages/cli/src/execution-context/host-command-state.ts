import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const hostCommandState = defineStateMachine({
	name: 'host_background_command.state',
	description:
		'Background commands exit, time out, kill or fail; a spawn error can finish a command already stopped by timeout or kill.',
	initial: 'running',
	transitions: {
		running: ['timed_out', 'failed', 'exited', 'killed'],
		exited: [],
		killed: ['failed'],
		timed_out: ['failed'],
		failed: [],
	},
})
export type HostCommandState = StateOf<typeof hostCommandState>
