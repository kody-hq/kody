import { backupExportState } from './backup-export-state.ts'

export const stateMachines = [
	{
		machine: backupExportState,
		file: 'packages/backup-control-plane/backup-export-state.ts',
	},
] as const
