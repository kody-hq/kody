import { expect, test } from 'vitest'
import { jobRunTriggerForContext, jobRunTriggerFromRecord } from './types.ts'

test('jobRunTriggerForContext marks scheduled-job keys as scheduled', () => {
	expect(jobRunTriggerForContext({ idempotencyKey: null })).toBe('manual')
	expect(jobRunTriggerForContext({ idempotencyKey: undefined })).toBe('manual')
	expect(jobRunTriggerForContext({ idempotencyKey: 'manual-retry-key' })).toBe(
		'manual',
	)
	expect(
		jobRunTriggerForContext({
			idempotencyKey: 'scheduled-job:job-1:2026-08-21T00:00:00.000Z',
		}),
	).toBe('scheduled')
})

test('jobRunTriggerFromRecord prefers metadata.trigger and falls back for legacy rows', () => {
	expect(
		jobRunTriggerFromRecord({
			idempotencyKey: null,
			metadata: { trigger: 'manual' },
		}),
	).toBe('manual')
	expect(
		jobRunTriggerFromRecord({
			idempotencyKey: 'scheduled-job:job-1:2026-08-21T00:00:00.000Z',
			metadata: {
				trigger: 'scheduled',
				scheduledFor: '2026-08-21T00:00:00.000Z',
			},
		}),
	).toBe('scheduled')
	expect(
		jobRunTriggerFromRecord({
			idempotencyKey: null,
			metadata: { trigger: 'retry' },
		}),
	).toBe('retry')
	expect(
		jobRunTriggerFromRecord({
			idempotencyKey: 'scheduled-job:job-1:2026-08-21T00:00:00.000Z',
			metadata: {},
		}),
	).toBe('scheduled')
	expect(
		jobRunTriggerFromRecord({
			idempotencyKey: null,
			metadata: {},
		}),
	).toBe('manual')
	expect(
		jobRunTriggerFromRecord({
			idempotencyKey: null,
			metadata: { trigger: '  ' },
		}),
	).toBe('manual')
})
