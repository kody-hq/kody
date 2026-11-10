import { createRequire } from 'node:module'
import type { AnyStateMachine } from 'xstate'
const require = createRequire(import.meta.url)
export const { updateReadinessState, updateCheckState } =
	require('./updates.cjs') as {
		updateReadinessState: AnyStateMachine
		updateCheckState: AnyStateMachine
	}
export const { executionOperationState } = require('./execution.cjs') as {
	executionOperationState: AnyStateMachine
}
export const stateMachines = [
	{
		machine: updateReadinessState,
		file: 'packages/desktop/updates.cjs',
	},
	{
		machine: updateCheckState,
		file: 'packages/desktop/updates.cjs',
	},
	{
		machine: executionOperationState,
		file: 'packages/desktop/execution.cjs',
	},
] as const
