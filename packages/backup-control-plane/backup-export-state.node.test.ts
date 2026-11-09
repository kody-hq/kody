import { expect, test } from 'vitest'
import { backupExportState } from './backup-export-state.ts'

test('backup_export_controller.kind preserves the accepted lifecycle graph', () => {
	expect(backupExportState.initial).toEqual(['complete', 'pending', 'lost'])
	expect(backupExportState.transitions).toEqual({
		complete: [],
		pending: ['pending', 'complete', 'lost'],
		lost: ['pending', 'complete', 'lost'],
	})
	expect(backupExportState.terminal).toEqual(['complete'])
})
