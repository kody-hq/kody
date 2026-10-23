import { expect, test } from 'vitest'
import {
	isWithinSoftDeleteRestoreWindow,
	softDeletePurgeCutoffIso,
	softDeleteRestoreDeadlineIso,
} from './window.ts'

test('softDeletePurgeCutoffIso is UTC ISO thirty days before now', () => {
	const now = new Date('2026-10-09T12:00:00.000Z')
	expect(softDeletePurgeCutoffIso(now)).toBe('2026-09-09T12:00:00.000Z')
})

test('isWithinSoftDeleteRestoreWindow respects retention window', () => {
	const now = new Date('2026-10-09T12:00:00.000Z')
	const recent = '2026-10-01T12:00:00.000Z'
	const stale = '2026-08-01T12:00:00.000Z'
	expect(isWithinSoftDeleteRestoreWindow(recent, now)).toBe(true)
	expect(isWithinSoftDeleteRestoreWindow(stale, now)).toBe(false)
	expect(isWithinSoftDeleteRestoreWindow('not-a-date', now)).toBe(false)
})

test('softDeleteRestoreDeadlineIso is thirty days after deletion', () => {
	const deletedAt = '2026-10-01T12:00:00.000Z'
	const deadline = softDeleteRestoreDeadlineIso(deletedAt)
	expect(deadline).toBe('2026-10-31T12:00:00.000Z')
	expect(isWithinSoftDeleteRestoreWindow(deletedAt, new Date(deadline!))).toBe(
		true,
	)
	expect(softDeleteRestoreDeadlineIso('not-a-date')).toBeNull()
})
