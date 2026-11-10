import { setup, types } from 'xstate'
import type { LifecycleStateOf } from '@kody-internal/shared/state-machine.ts'

export const backupExportState = setup({
	schemas: {
		events: {
			EXPORT_PENDING: types<{}>(),
			EXPORT_READY: types<{}>(),
			EXPORT_LOST: types<{}>(),
		},
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
				EXPORT_PENDING: { target: 'pending' },
				EXPORT_READY: { target: 'complete' },
				EXPORT_LOST: { target: 'lost' },
			},
		},
		lost: {
			on: {
				EXPORT_PENDING: { target: 'pending' },
				EXPORT_READY: { target: 'complete' },
				EXPORT_LOST: { target: 'lost' },
			},
		},
	},
})
export type BackupExportPhase = LifecycleStateOf<typeof backupExportState>
