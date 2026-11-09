import { expect, test } from 'vitest'
import { backupExportState } from './backup-export-state.ts'

test('lost exports can restart; a complete export cannot', () => {
	expect(backupExportState.can('pending', 'lost')).toBe(true)
	expect(backupExportState.can('lost', 'pending')).toBe(true)
	expect(backupExportState.can('lost', 'complete')).toBe(true)
	expect(backupExportState.isTerminal('complete')).toBe(true)
	expect(backupExportState.can('complete', 'pending')).toBe(false)
	expect(backupExportState.can('complete', 'lost')).toBe(false)
})
