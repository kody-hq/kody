import { setup } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const backupExportState = setup({
	types: {
		events: {} as
			| { type: 'EXPORT_PENDING' }
			| { type: 'EXPORT_READY' }
			| { type: 'EXPORT_LOST' },
	},
}).createMachine({
	id: 'backup_export_controller.kind',
	description:
		'The owned export controller polls pending exports and restarts lost exports until complete, preserving its bounded retry and polling rules. Rows or initial responses may enter directly in another listed state.',
	initial: 'pending',
	states: {
		complete: { type: 'final' },
		pending: {
			on: {
				EXPORT_PENDING: 'pending',
				EXPORT_READY: 'complete',
				EXPORT_LOST: 'lost',
			},
		},
		lost: {
			on: {
				EXPORT_PENDING: 'pending',
				EXPORT_READY: 'complete',
				EXPORT_LOST: 'lost',
			},
		},
	},
})
export type BackupExportPhase = LifecycleStateOf<typeof backupExportState>
