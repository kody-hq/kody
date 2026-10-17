import { expect, test } from 'vitest'
import { getScheduledLaneCadence } from '@kody-internal/shared/jobs/scheduled-lanes.ts'

test('hourly cadence dispatches unverified account purge with retention', () => {
	const hourly = getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z'))
	expect(hourly).toContain('retention')
	expect(hourly).toContain('unverified_account_purge')
	const offHour = getScheduledLaneCadence(new Date('2026-09-02T12:05:00.000Z'))
	expect(offHour.includes('retention')).toBe(false)
	expect(offHour.includes('unverified_account_purge')).toBe(false)
})

test('DLQ depth alert is dispatched on every cron tick', () => {
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:05:00.000Z')),
	).toContain('dlq_depth_alert')
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z')),
	).toContain('dlq_depth_alert')
})

test('Durable Object duration attribution runs once an hour at minute 20', () => {
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:20:00.000Z')),
	).toContain('durable_object_duration_attribution')
	expect(
		getScheduledLaneCadence(new Date('2026-09-02T12:00:00.000Z')),
	).not.toContain('durable_object_duration_attribution')
})

test('gift reconciliation is dispatched on every existing five-minute tick', () => {
	for (const minute of ['00', '05', '25', '55']) {
		expect(
			getScheduledLaneCadence(new Date(`2026-10-15T12:${minute}:00Z`)),
		).toContain('second_agent_gift_reconciliation')
	}
})
