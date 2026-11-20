import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
	enqueueWorkflow,
	type WorkflowInstanceStatus,
} from './workflow-trigger.ts'

type CreateOptions = { id: string; params: { day: string } }

/** Workflow whose instance already exists with `status`; create always throws `createError`. */
function existing(
	status: WorkflowInstanceStatus,
	createError = 'instance already exists',
) {
	let restarts = 0
	const workflow = {
		async create(_options: CreateOptions) {
			throw new Error(createError)
		},
		async get() {
			return {
				status: async () => ({ status }),
				restart: async () => {
					restarts += 1
				},
			}
		},
	}
	return { workflow, restarts: () => restarts }
}

const instanceId = 'seal-day-2026-07-22'
const payload = () => ({ day: '2026-07-22' })

test('workflow creation omits explicit retention and active overlap stays duplicate', async () => {
	let createdOptions: CreateOptions | undefined
	const workflow = {
		...existing('running').workflow,
		async create(options: CreateOptions) {
			if (createdOptions) throw new Error('instance already exists')
			createdOptions = options
		},
	}
	const params = payload()
	assert.equal(await enqueueWorkflow(workflow, instanceId, params), 'created')
	assert.equal(await enqueueWorkflow(workflow, instanceId, params), 'duplicate')
	assert.equal(createdOptions?.id, instanceId)
})

test('enqueueWorkflow status matrix: leave active alone, restart failed, fail closed', async () => {
	const params = payload()
	const cases: Array<
		[WorkflowInstanceStatus, 'duplicate' | 'restarted', number]
	> = [
		['queued', 'duplicate', 0],
		['running', 'duplicate', 0],
		['paused', 'duplicate', 0],
		['complete', 'duplicate', 0],
		['waiting', 'duplicate', 0],
		['waitingForPause', 'duplicate', 0],
		['rollingBack', 'duplicate', 0],
		['errored', 'restarted', 1],
		['terminated', 'restarted', 1],
	]
	for (const [status, outcome, restarts] of cases) {
		const double = existing(status)
		assert.equal(
			await enqueueWorkflow(double.workflow, instanceId, params),
			outcome,
		)
		assert.equal(double.restarts(), restarts)
	}

	for (const status of ['unknown', 'unexpected']) {
		const double = existing(
			status as WorkflowInstanceStatus,
			'original create failure',
		)
		await assert.rejects(
			enqueueWorkflow(double.workflow, instanceId, params),
			/original create failure/,
		)
		assert.equal(double.restarts(), 0)
	}
})
