import { expect, test } from 'vitest'
import { getScheduledLaneCadence } from '@kody-internal/shared/jobs/scheduled-lanes.ts'

test('scheduled lanes use their intended cadences', () => {
	const hourly = getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z'))
	expect(hourly).toContain('retention')
	expect(hourly).toContain('unverified_account_purge')
	const offHour = getScheduledLaneCadence(new Date('2026-09-02T12:05:00.000Z'))
	expect(offHour.includes('retention')).toBe(false)
	expect(offHour.includes('unverified_account_purge')).toBe(false)
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z')),
	).toContain('dlq_depth_alert')
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:05:00.000Z')),
	).toContain('dlq_depth_alert')
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:20:00.000Z')),
	).toContain('durable_object_duration_attribution')
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z')),
	).not.toContain('durable_object_duration_attribution')
	for (const minute of ['00', '05', '25', '55']) {
		expect(
			getScheduledLaneCadence(new Date(`2026-10-15T12:${minute}:00Z`)),
		).toContain('second_agent_gift_reconciliation')
	}
	expect(
		getScheduledLaneCadence(new Date('2026-10-19T12:00:00.000Z')),
	).toContain('fleet_users_affected_alert')
	expect(
		getScheduledLaneCadence(new Date('2026-10-19T12:15:00.000Z')),
	).toContain('fleet_users_affected_alert')
	expect(
		getScheduledLaneCadence(new Date('2026-10-19T12:05:00.000Z')),
	).not.toContain('fleet_users_affected_alert')
	expect(
		getScheduledLaneCadence(new Date('2026-10-24T01:00:00.000Z')),
	).toContain('dr_d1_paced_backup')
	expect(
		getScheduledLaneCadence(new Date('2026-10-24T06:15:00.000Z')),
	).toContain('dr_d1_paced_backup_watchdog')
	expect(
		getScheduledLaneCadence(new Date('2026-10-24T12:05:00.000Z')),
	).toContain('dr_d1_paced_backup')
})
