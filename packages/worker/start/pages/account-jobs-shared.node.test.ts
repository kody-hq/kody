import { expect, test } from 'vitest'
import {
	runNowSuccessMessage,
	runNowSuccessTone,
} from './account-jobs-shared.ts'

test('runNowSuccessMessage reports a finished success, not a request', () => {
	expect(runNowSuccessMessage({ ok: true, jobId: 'job-1' })).toBe(
		'Job ran successfully.',
	)
	expect(
		runNowSuccessMessage({
			ok: true,
			jobId: 'job-1',
			runNow: { ok: true, error: null },
		}),
	).toBe('Job ran successfully.')
})

test('runNowSuccessMessage and tone use the error style for a failed run', () => {
	expect(
		runNowSuccessMessage({
			ok: true,
			jobId: 'job-1',
			runNow: { ok: false, error: 'boom' },
		}),
	).toBe('Run finished with an error: boom')
	expect(
		runNowSuccessMessage({
			ok: true,
			jobId: 'job-1',
			runNow: { ok: false, error: null },
		}),
	).toBe('Run finished with an error.')
	expect(
		runNowSuccessTone({
			ok: true,
			jobId: 'job-1',
			runNow: { ok: false, error: 'boom' },
		}),
	).toBe('error')
	expect(
		runNowSuccessTone({
			ok: true,
			jobId: 'job-1',
			runNow: { ok: true, error: null },
		}),
	).toBe('info')
})

test('runNowSuccessMessage does not claim success for a context handoff', () => {
	expect(
		runNowSuccessMessage({
			ok: true,
			jobId: 'job-1',
			runNow: {
				ok: true,
				error: null,
				contextRun: { state: 'queued', context: 'laptop', expiresAt: null },
			},
		}),
	).toBe(
		'laptop is offline. The run is queued until it reconnects; Activity shows the result.',
	)
	expect(
		runNowSuccessMessage({
			ok: true,
			jobId: 'job-1',
			runNow: {
				ok: true,
				error: null,
				contextRun: { state: 'running', context: 'desk', expiresAt: null },
			},
		}),
	).toBe('Started on desk. Activity shows the result.')
})
