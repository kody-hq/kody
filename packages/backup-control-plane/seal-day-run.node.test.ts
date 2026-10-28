import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { NonRetryableError } from 'cloudflare:workflows'
import {
	RetryingWorkflowStep,
	backupError,
	environment,
} from './backup-control-plane-test-support.ts'
import {
	completeSealDay,
	describeSealStatus,
	runSealDay,
	sealDayStepName,
	sealStatusResponseStatus,
} from './seal-day-run.ts'
import { withNonRetryableBackupErrors } from './workflow-step-boundary.ts'

test('seal workflow step returns a sealed day and does not retry an incomplete day', async () => {
	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	const env = environment()
	const day = '2026-09-22'
	const engine = new RetryingWorkflowStep()
	const step = withNonRetryableBackupErrors(engine)
	const manifestKey = `daily/full/${day}/manifest.json`
	const sealedDay = (alreadySealed: boolean) => async () => ({
		kind: 'sealed' as const,
		day,
		manifestKey,
		alreadySealed,
	})

	const sealed = await runSealDay(env, day, step, sealedDay(true))
	assert.equal(sealed.alreadySealed, true)
	assert.equal(engine.attempts, 1)

	assert.equal(
		(await completeSealDay(env, day, sealedDay(false))).alreadySealed,
		false,
	)

	engine.attempts = 0
	await assert.rejects(
		runSealDay(env, day, step),
		(error: unknown) =>
			error instanceof NonRetryableError &&
			error.message ===
				'[d1-manifest-missing] Day 2026-09-22 is not ready to seal (d1-manifest-missing).',
	)
	assert.equal(engine.attempts, 1)
	assert.deepEqual(engine.names, [sealDayStepName, sealDayStepName])
	const operatorFailure = consoleError.mock.calls
		.map((call) => JSON.parse(String(call[0])))
		.find((log) => log.event === 'ui-seal-day')
	assert.equal(operatorFailure?.status, 'failure')
	assert.equal(operatorFailure?.errorCode, 'd1-manifest-missing')

	await assert.rejects(
		completeSealDay(env, 'not-a-day', async () => {
			throw new Error('seal should not run')
		}),
		backupError('invalid-day', false),
	)

	const incomplete = describeSealStatus({
		status: 'errored',
		error: {
			message:
				'[staging-summary-missing] Day 2026-09-22 is not ready to seal (staging-summary-missing).',
		},
	})
	assert.deepEqual(incomplete, {
		kind: 'incomplete',
		reason: 'staging-summary-missing',
	})
	assert.equal(sealStatusResponseStatus(incomplete), 409)

	const alreadySealed = describeSealStatus({
		status: 'complete',
		output: { kind: 'sealed', day, manifestKey, alreadySealed: true },
	})
	assert.deepEqual(alreadySealed, {
		kind: 'sealed',
		manifestKey,
		alreadySealed: true,
	})
	assert.equal(sealStatusResponseStatus(alreadySealed), 200)
	assert.deepEqual(describeSealStatus({ status: 'running' }), {
		kind: 'pending',
		status: 'running',
	})
})
