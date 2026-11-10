import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { backupExportState } from './backup-export-state.ts'

test('lost exports can restart; a complete export cannot', () => {
	expect(canHandle(backupExportState, 'pending', 'EXPORT_LOST')).toBe(true)
	expect(canHandle(backupExportState, 'lost', 'EXPORT_PENDING')).toBe(true)
	expect(canHandle(backupExportState, 'lost', 'EXPORT_READY')).toBe(true)
	expect(finalStatesOf(backupExportState).includes('complete')).toBe(true)
	expect(canHandle(backupExportState, 'complete', 'EXPORT_PENDING')).toBe(false)
	expect(canHandle(backupExportState, 'complete', 'EXPORT_LOST')).toBe(false)
})
