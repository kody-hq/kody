import { defineStateMachine } from '@kody-internal/shared/state-machine.ts'
export const desktopSetupOperationState = defineStateMachine({
	name: 'desktop.setup_operation',
	description:
		'Bridge actions fence user input through reconciliation; only a failed operation carries an error and retry clears it.',
	initial: 'idle',
	transitions: {
		idle: ['running'],
		running: ['idle', 'error'],
		error: ['idle', 'running'],
	},
})
export type DesktopSetupOperation =
	| { status: 'idle' | 'running' }
	| { status: 'error'; message: string }
