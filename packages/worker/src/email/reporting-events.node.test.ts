import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { recordEmailReportingEvent } from './reporting-events.ts'

test('email reporting writes a compact indexed delivery data point', () => {
	const writeDataPoint = vi.fn()
	const env = {
		EMAIL_EVENTS: {
			writeDataPoint,
		} as unknown as AnalyticsEngineDataset,
	}

	recordEmailReportingEvent(env, {
		userId: ownerIdFromStored('user-1'),
		eventType: 'email_delivery',
		outcome: 'bounced',
		timestamp: '2026-07-31T00:00:00.000Z',
	})

	expect(writeDataPoint).toHaveBeenCalledOnce()
	expect(writeDataPoint).toHaveBeenCalledWith({
		indexes: ['user-1'],
		blobs: ['email_delivery', 'bounced', '2026-07-31T00:00:00.000Z'],
		doubles: [1],
	})
})

test('email reporting never throws when the binding is absent or fails', () => {
	consoleWarn.mockImplementation(() => {})
	expect(() =>
		recordEmailReportingEvent(
			{},
			{
				userId: ownerIdFromStored('user-1'),
				eventType: 'email_send',
			},
		),
	).not.toThrow()
	expect(() =>
		recordEmailReportingEvent(
			{
				EMAIL_EVENTS: {
					writeDataPoint() {
						throw new Error('analytics unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{
				userId: ownerIdFromStored('user-1'),
				eventType: 'email_delivery',
				outcome: 'failed',
			},
		),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith(
		'email-reporting-event-write-failed',
		expect.objectContaining({ message: 'analytics unavailable' }),
	)
})
