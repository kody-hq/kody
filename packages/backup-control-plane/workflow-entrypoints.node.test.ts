import assert from 'node:assert/strict'

import { type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { test, vi } from 'vitest'

import { errorCode } from './backup-policy.ts'
import {
	RetryingWorkflowStep,
	environment,
} from './backup-control-plane-test-support.ts'
import { ProductionDrRestoreWorkflow } from './restore-workflow.ts'
import { ProductionSealDayWorkflow } from './seal-day-workflow.ts'

function workflowEvent<T>(payload: T): WorkflowEvent<T> {
	return {
		payload,
		timestamp: new Date('2026-09-23T00:00:00.000Z'),
		instanceId: 'test-instance',
	} as WorkflowEvent<T>
}

test('a non-retryable backup failure inside a workflow step runs exactly once', async () => {
	vi.spyOn(console, 'error').mockImplementation(() => {})
	vi.spyOn(console, 'log').mockImplementation(() => {})
	const day = '2026-09-22'
	const cases = [
		{
			workflow: new ProductionSealDayWorkflow({} as never, environment()),
			code: 'd1-manifest-missing',
		},
		{
			workflow: new ProductionDrRestoreWorkflow({} as never, environment()),
			code: null,
		},
	]
	for (const { workflow, code } of cases) {
		const engine = new RetryingWorkflowStep()
		const error = await workflow
			.run(workflowEvent({ day } as never), engine as unknown as WorkflowStep)
			.then(
				() => assert.fail('expected the workflow to fail'),
				(reason: unknown) => reason,
			)
		// The refused step is not retried.
		assert.equal(engine.attempts, 1)
		assert.ok(error instanceof Error)
		// The engine only stops retrying on this exact name.
		assert.equal(error.name, 'NonRetryableError')
		// The backup code stays readable from the message.
		assert.notEqual(errorCode(error), 'unexpected-error')
		if (code) assert.equal(errorCode(error), code)
	}
	vi.restoreAllMocks()
})
