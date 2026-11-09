import { createRequire } from 'node:module'
import { defineStateMachine } from '../shared/src/state-machine.ts'
const require = createRequire(import.meta.url)
const { updateReadinessTransitions, updateCheckTransitions } =
	require('./updates.cjs') as {
		updateReadinessTransitions: {
			readonly waiting: readonly 'downloaded'[]
			readonly downloaded: readonly ('downloaded' | 'installing')[]
			readonly installing: readonly ('downloaded' | 'installing')[]
		}
		updateCheckTransitions: {
			readonly idle: readonly 'checking'[]
			readonly checking: readonly 'idle'[]
		}
	}
const { executionOperationTransitions } = require('./execution.cjs') as {
	executionOperationTransitions: {
		readonly idle: readonly ('running' | 'error')[]
		readonly running: readonly ('idle' | 'running' | 'error')[]
		readonly error: readonly ('idle' | 'running' | 'error')[]
	}
}
export const updateReadinessState = defineStateMachine({
	name: 'desktop.update_readiness',
	description:
		'Downloaded readiness survives later failed checks; installation is fenced until the app quits.',
	initial: 'waiting',
	transitions: updateReadinessTransitions,
})
export const updateCheckState = defineStateMachine({
	name: 'desktop.update_check',
	description:
		'One update check owns its promise through download and manual feedback, independently of downloaded readiness.',
	initial: 'idle',
	transitions: updateCheckTransitions,
})
export const executionOperationState = defineStateMachine({
	name: 'desktop.machine_operation',
	description:
		'Connection and daemon actions run exclusively; a retry clears earlier errors while OS runner observations remain external.',
	initial: 'idle',
	transitions: executionOperationTransitions,
})
export const stateMachines = [
	{
		machine: updateReadinessState,
		file: 'packages/desktop/updates.cjs',
		definitionFile: 'packages/desktop/state-machines.mts',
	},
	{
		machine: updateCheckState,
		file: 'packages/desktop/updates.cjs',
		definitionFile: 'packages/desktop/state-machines.mts',
	},
	{
		machine: executionOperationState,
		file: 'packages/desktop/execution.cjs',
		definitionFile: 'packages/desktop/state-machines.mts',
	},
] as const
