import assert from 'node:assert/strict'

import { test } from 'vitest'

import { backupPayload } from './backup-policy.ts'
import { type ScheduledBackupPayload } from './backup-types.ts'
import {
	enqueueBackup,
	enqueueBackupRetry,
	isApprovedRetryWindow,
	primaryBackupTimeForDay,
	type WorkflowInstanceStatus,
} from './workflow-trigger.ts'
import {
	DATABASE_ID,
	environment,
} from './backup-control-plane-test-support.ts'

type CreateOptions = { id: string; params: ScheduledBackupPayload }

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

/** Workflow with no instance yet; records each create. */
function missing() {
	const created: CreateOptions[] = []
	const workflow = {
		async create(options: CreateOptions) {
			created.push(options)
		},
		async get(): Promise<never> {
			throw new Error('instance missing')
		},
	}
	return { workflow, created }
}

const dailyPayload = () =>
	backupPayload(environment(), new Date('2026-07-22T02:15:00Z'))
const retryPayload = (tick: Date) =>
	backupPayload(environment(), primaryBackupTimeForDay(tick))

test('workflow creation omits explicit retention and active overlap stays duplicate', async () => {
	let createdOptions: CreateOptions | undefined
	const workflow = {
		...existing('running').workflow,
		async create(options: CreateOptions) {
			if (createdOptions) throw new Error('instance already exists')
			createdOptions = options
		},
	}
	const payload = dailyPayload()
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'created')
	assert.equal(await enqueueBackup(workflow, DATABASE_ID, payload), 'duplicate')
})

test('enqueueBackup status matrix: leave active alone, restart failed, fail closed', async () => {
	const payload = dailyPayload()
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
			await enqueueBackup(double.workflow, DATABASE_ID, payload),
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
			enqueueBackup(double.workflow, DATABASE_ID, payload),
			/original create failure/,
		)
		assert.equal(double.restarts(), 0)
	}
})

test('hourly freshness retries are bounded to 02:45 through 05:45 UTC', () => {
	for (const hour of [2, 3, 4, 5]) {
		assert.equal(
			isApprovedRetryWindow(new Date(`2026-07-22T0${hour}:45:00Z`)),
			true,
		)
	}
	for (const time of ['01:45', '06:45', '03:44']) {
		assert.equal(
			isApprovedRetryWindow(new Date(`2026-07-22T${time}:00Z`)),
			false,
		)
	}
})

test('missed 02:15 creation is caught up with the canonical payload', async () => {
	const { workflow, created } = missing()
	const tick = new Date('2026-07-22T02:45:00Z')
	assert.equal(
		await enqueueBackupRetry(workflow, DATABASE_ID, retryPayload(tick), tick),
		'created',
	)
	assert.equal(created.length, 1)
	assert.equal(created[0]?.params.scheduledAt, '2026-07-22T02:15:00.000Z')
	assert.equal(created[0]?.id, `d1-backup-${DATABASE_ID}-2026-07-22`)
})

test('concurrent retry ticks idempotently create one deterministic instance', async () => {
	let creates = 0
	let exists = false
	const workflow = {
		...existing('running').workflow,
		async create() {
			await Promise.resolve()
			if (exists) throw new Error('instance already exists')
			exists = true
			creates += 1
		},
	}
	const tick = new Date('2026-07-22T03:45:00Z')
	const payload = retryPayload(tick)
	assert.deepEqual(
		(
			await Promise.all([
				enqueueBackupRetry(workflow, DATABASE_ID, payload, tick),
				enqueueBackupRetry(workflow, DATABASE_ID, payload, tick),
			])
		).sort(),
		['created', 'duplicate'],
	)
	assert.equal(creates, 1)
})

test('outside-window retry never creates a missing instance', async () => {
	const { workflow, created } = missing()
	const tick = new Date('2026-07-22T06:45:00Z')
	assert.equal(
		await enqueueBackupRetry(workflow, DATABASE_ID, retryPayload(tick), tick),
		'outside-window',
	)
	assert.equal(created.length, 0)
})

test('retry ticks leave active/complete alone and fail closed on unknown', async () => {
	const tick = new Date('2026-07-22T03:45:00Z')
	for (const status of ['running', 'complete'] as const) {
		const double = existing(status)
		assert.equal(
			await enqueueBackupRetry(
				double.workflow,
				DATABASE_ID,
				retryPayload(tick),
				tick,
			),
			'duplicate',
		)
		assert.equal(double.restarts(), 0)
	}
	await assert.rejects(
		enqueueBackupRetry(
			existing('unknown').workflow,
			DATABASE_ID,
			retryPayload(tick),
			tick,
		),
		/instance already exists/,
	)
})
