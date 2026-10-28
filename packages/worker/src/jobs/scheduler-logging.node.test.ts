import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	logJobSchedulerError,
	summarizeSchedulerJobOutcomes,
} from './scheduler-logging.ts'

test('logJobSchedulerError truncates oversized fields, caps outcome count, and always emits a timestamp', () => {
	const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
	try {
		const manyOutcomes = Array.from({ length: 11 }, (_, index) => ({
			jobId: `job-${index}`,
			scheduleType: 'cron' as const,
			outcome: 'success' as const,
			nextRunAt: null,
			deleted: false,
		}))
		expect(summarizeSchedulerJobOutcomes(manyOutcomes)).toEqual({
			jobOutcomes: manyOutcomes.slice(0, 10),
			truncatedJobOutcomeCount: 1,
		})

		logJobSchedulerError({
			event: 'sync_alarm_failed',
			userId: ownerIdFromStored('user-123'),
			errorName: 'Error',
			errorMessage: 'y'.repeat(1205),
		})

		logJobSchedulerError({
			event: 'alarm_processed_due_jobs',
			userId: ownerIdFromStored('user-123'),
			jobOutcomes: [
				{
					jobId: 'job-123',
					scheduleType: 'cron',
					outcome: 'failure',
					nextRunAt: null,
					deleted: true,
					error: 'z'.repeat(1100),
					rescheduleError: 'w'.repeat(1010),
				},
			],
		})

		logJobSchedulerError({
			event: 'sync_alarm_failed',
			userId: ownerIdFromStored('user-123'),
			errorName: 'Error',
			errorMessage: 'boom',
			timestamp: undefined,
		})

		expect(errorSpy).toHaveBeenCalledTimes(3)
		const topLevelPayload = JSON.parse(
			(errorSpy.mock.calls[0] ?? [])[1] as string,
		) as Record<string, unknown>
		expect((errorSpy.mock.calls[0] ?? [])[0]).toBe('job-scheduler')
		expect(String(topLevelPayload.errorMessage).length).toBeLessThan(1_205)

		const jobOutcomePayload = JSON.parse(
			(errorSpy.mock.calls[1] ?? [])[1] as string,
		) as {
			jobOutcomes: Array<Record<string, unknown>>
		}
		const outcome = jobOutcomePayload.jobOutcomes[0] ?? {}
		expect(String(outcome.error).length).toBeLessThan(1_100)
		expect(outcome.rescheduleError).not.toBe('w'.repeat(1_010))

		const timestampPayload = JSON.parse(
			(errorSpy.mock.calls[2] ?? [])[1] as string,
		) as Record<string, unknown>
		expect(timestampPayload.timestamp).toEqual(expect.any(String))
		expect(timestampPayload.timestamp).not.toBe('')
	} finally {
		errorSpy.mockRestore()
	}
})
