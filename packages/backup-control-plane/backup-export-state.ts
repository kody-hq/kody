import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'

export const backupExportState = defineStateMachine({
	name: 'backup_export_controller.kind',
	description:
		'The owned export controller polls pending exports and restarts lost exports until complete, preserving its bounded retry and polling rules.',
	initial: ['complete', 'pending', 'lost'],
	transitions: {
		complete: [],
		pending: ['pending', 'complete', 'lost'],
		lost: ['pending', 'complete', 'lost'],
	},
})
export type BackupExportPhase = StateOf<typeof backupExportState>
