import { hostCommandState } from './execution-context/host-command-state.ts'

export const stateMachines = [
	{
		machine: hostCommandState,
		file: 'packages/cli/src/execution-context/host-command-state.ts',
	},
] as const
