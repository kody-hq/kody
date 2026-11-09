import { componentIncidentState } from './incident-state.ts'

export const stateMachines = [
	{
		machine: componentIncidentState,
		file: 'packages/status/incident-state.ts',
	},
] as const
