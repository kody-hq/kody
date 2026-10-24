import assert from 'node:assert/strict'

import { test } from 'vitest'

import { NonRetryableError } from 'cloudflare:workflows'
import { BackupError, errorCode } from './backup-policy.ts'
import { RetryingWorkflowStep } from './backup-control-plane-test-support.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'

test('Workflow step boundary fails fast for non-retryable errors and retries transient ones', async () => {
	const nonRetryEngine = new RetryingWorkflowStep()
	const nonRetryStep = withNonRetryableBackupErrors(nonRetryEngine)

	await assert.rejects(
		nonRetryStep.do('non-retryable', { retries: { limit: 3 } }, async () => {
			throw new BackupError('invalid-workflow-payload', 'invalid payload')
		}),
		(error: unknown) =>
			error instanceof NonRetryableError &&
			error.name === 'NonRetryableError' &&
			errorCode(error) === 'invalid-workflow-payload',
	)
	assert.equal(nonRetryEngine.attempts, 1)

	for (const retryableError of [
		new BackupError('d1-export-transient', 'try again', true),
		new Error('temporary network error'),
	]) {
		const engineStep = new RetryingWorkflowStep()
		const step = withNonRetryableBackupErrors(engineStep)
		let callbacks = 0
		const result = await step.do(
			'retryable',
			{ retries: { limit: 2 } },
			async () => {
				callbacks += 1
				if (callbacks === 1) throw retryableError
				return 'complete'
			},
		)
		assert.equal(result, 'complete')
		assert.equal(engineStep.attempts, 2)
	}
})
