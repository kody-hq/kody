import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { RunLog } from './run-log-do.ts'
import { seedRunLogMeta } from './run-log-meta-test-seed.ts'
import {
	beginRunRecord,
	claimPackageInvocationRecord,
	clearRunRecords,
	countActiveWorkflowProjections,
	exportRunRecords,
	findWorkflowProjectionByBindingIdempotencyKey,
	findWorkflowProjectionByIdempotencyKey,
	finishPackageInvocationRecord,
	finishRunRecord,
	getAdminInsightsSnapshot,
	getJobRunObservability,
	getJobRunObservabilityBatch,
	getSqlBillingStats,
	inspectRunLogSqlBilling,
	getWorkflowProjection,
	listActivationMilestones,
	listPackageRunSuccesses,
	listRunRecords,
	listWorkflowProjections,
	releaseWorkflowProjectionIdempotencyKey,
	reserveWorkflowProjectionSlot,
	deleteWorkflowProjectionIfCreating,
	upsertJobRunObservability,
	upsertWorkflowProjection,
	workflowProjectionCreatingTtlMs,
} from './service.ts'
import {
	runRecordMaxRunsPerUser,
	runRecordRetentionEveryNFinishes,
	type RunRecordContext,
} from './types.ts'
import { type WorkflowProjectionUpsertInput } from './workflow-projection.ts'

const dynamicBinding = 'DYNAMIC_CALLABLE_WORKFLOWS'
const dayMs = 24 * 60 * 60 * 1000
const jobRunObservabilityColumns = [
	'job_id',
	'last_run_at',
	'last_run_status',
	'last_run_error',
	'last_duration_ms',
	'run_count',
	'success_count',
	'error_count',
	'updated_at',
]
const runsTriageColumns = [
	'error_triage',
	'triage_note',
	'triaged_at',
	'triaged_by',
	'log_count',
]
const legacyRunsColumnsDdl = `
	id TEXT PRIMARY KEY NOT NULL, surface TEXT NOT NULL, status TEXT NOT NULL,
	name TEXT, package_id TEXT, package_kody_id TEXT, source_id TEXT,
	published_commit TEXT, storage_id TEXT, job_id TEXT, workflow_id TEXT,
	invocation_id TEXT, session_id TEXT, idempotency_key TEXT,
	parent_run_id TEXT, started_at TEXT NOT NULL, finished_at TEXT,
	duration_ms INTEGER, error_name TEXT, error_message TEXT,
	metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL`

function uniqueUserId(label: string): OwnerId {
	return ownerIdFromStored(`runlog-dedicated-${label}-${crypto.randomUUID()}`)
}

function runLogStub(userId: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(namespace.idFromName(userId))
}

function workflow(
	id: string,
	overrides: Partial<WorkflowProjectionUpsertInput> = {},
): WorkflowProjectionUpsertInput {
	return {
		id,
		bindingName: dynamicBinding,
		sourceType: 'inline',
		workflowName: 'adhoc',
		idempotencyKey: `idem-${id}`,
		runAt: '2026-07-31T00:00:00.000Z',
		...overrides,
	}
}

function upsertWorkflow(
	userId: string,
	id: string,
	overrides?: Partial<WorkflowProjectionUpsertInput>,
) {
	return upsertWorkflowProjection({
		env,
		userId: ownerIdFromStored(userId),
		projection: workflow(id, overrides),
	})
}

function finishBegunRun(
	userId: string,
	context: RunRecordContext,
	status: 'success' | 'error' = 'success',
) {
	return finishRunRecord({
		env,
		handle: beginRunRecord({ env, userId: ownerIdFromStored(userId), context }),
		status,
	})
}

/** Claims a keyed package invocation and returns a replayable finisher. */
async function claimInvocation(
	userId: string,
	packageId: string,
	idempotencyKey: string,
) {
	const claimed = await claimPackageInvocationRecord({
		env,
		userId: ownerIdFromStored(userId),
		context: { surface: 'export', packageId, name: 'handler', idempotencyKey },
		invocation: {
			id: crypto.randomUUID(),
			tokenId: `token-${packageId}`,
			packageId,
			packageKodyId: `kody-${packageId}`,
			exportName: 'handler',
			idempotencyKey,
			requestHash: `hash-${idempotencyKey}`,
			source: null,
			topic: null,
		},
		staleBefore: new Date(0).toISOString(),
	})
	if (claimed.outcome !== 'claimed') throw new Error('expected claim')
	return () =>
		finishPackageInvocationRecord({
			env,
			userId: ownerIdFromStored(userId),
			handle: claimed.handle,
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			ledgerStatus: 'completed',
			responseJson: JSON.stringify({ ok: true }),
			status: 'success',
		})
}

async function armRetentionOnNextFinish(userId: string, runCount?: number) {
	await runInDurableObject(runLogStub(userId), async (instance: RunLog) => {
		expect(instance).toBeInstanceOf(RunLog)
		seedRunLogMeta(instance, {
			finishesSinceRetention: runRecordRetentionEveryNFinishes - 1,
			runCount,
		})
	})
}

function insertAgedRun(
	state: DurableObjectState,
	input: { id: string; startedAt: string },
) {
	state.storage.sql.exec(
		`INSERT INTO runs (
			id, surface, status, name, package_id, package_kody_id, source_id,
			published_commit, storage_id, job_id, workflow_id, invocation_id,
			session_id, idempotency_key, parent_run_id, started_at, finished_at,
			duration_ms, error_name, error_message, metadata_json, created_at,
			updated_at
		) VALUES (?, 'job', 'success', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
			NULL, NULL, NULL, NULL, NULL, ?, ?, 1, NULL, NULL, '{}', ?, ?)`,
		input.id,
		input.startedAt,
		input.startedAt,
		input.startedAt,
		input.startedAt,
	)
}

function columnNames(state: DurableObjectState, table: string) {
	return state.storage.sql
		.exec<{ name: string }>(`PRAGMA table_info(${table})`)
		.toArray()
		.map((row) => String(row.name))
}

function schemaVersion(state: DurableObjectState) {
	return Number(
		state.storage.sql
			.exec<{ value: number }>(
				`SELECT value FROM run_log_meta WHERE key = 'schema_version' LIMIT 1`,
			)
			.toArray()[0]?.value,
	)
}

/** Replace the DO's storage with a legacy schema, run `seed`, then upgrade. */
async function upgradeFromLegacySchema(
	userId: string,
	version: number,
	seed: (state: DurableObjectState) => void,
	verify: (state: DurableObjectState) => void,
) {
	await runInDurableObject(
		runLogStub(userId),
		async (instance: RunLog, state) => {
			expect(instance).toBeInstanceOf(RunLog)
			await state.storage.deleteAll()
			state.storage.sql.exec(
				`CREATE TABLE run_log_meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL)`,
			)
			state.storage.sql.exec(
				`INSERT INTO run_log_meta (key, value) VALUES ('schema_version', ?)`,
				version,
			)
			seed(state)
			const proto = Object.getPrototypeOf(instance) as {
				initializeSchema: () => void
			}
			proto.initializeSchema.call(instance)
			expect(schemaVersion(state)).toBe(13)
			verify(state)
		},
	)
}

test('releaseWorkflowProjectionIdempotencyKey frees a dead run for same-key create', async () => {
	const userId = uniqueUserId('wf-release-key')
	await upsertWorkflow(userId, 'wf-errored', {
		idempotencyKey: 'publish-same-commit',
		status: 'errored',
		completedAt: '2026-07-30T00:01:00.000Z',
		lastError: 'Durable Object reset because its code was updated.',
	})
	expect(
		await findWorkflowProjectionByIdempotencyKey({
			env,
			userId,
			idempotencyKey: 'publish-same-commit',
		}),
	).toMatchObject({ id: 'wf-errored' })

	const released = await releaseWorkflowProjectionIdempotencyKey({
		env,
		userId,
		id: 'wf-errored',
	})
	expect(released).toEqual({
		released: true,
		previousKey: 'publish-same-commit',
	})
	expect(
		await findWorkflowProjectionByIdempotencyKey({
			env,
			userId,
			idempotencyKey: 'publish-same-commit',
		}),
	).toBeNull()
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-errored' }),
	).toMatchObject({
		idempotencyKey: 'released:wf-errored',
		status: 'errored',
	})
	expect(
		await releaseWorkflowProjectionIdempotencyKey({
			env,
			userId,
			id: 'wf-errored',
		}),
	).toEqual({ released: false, previousKey: 'released:wf-errored' })
})

test('workflow projections track binding name, idempotency, and active counts', async () => {
	const userId = uniqueUserId('workflows')
	const nightly = {
		sourceType: 'package',
		packageId: 'pkg-1',
		workflowName: 'nightly',
		exportName: 'run',
	} as const
	await upsertWorkflow(userId, 'wf-active-1', {
		...nightly,
		kodyId: 'kody-1',
		sourceId: 'src-1',
		idempotencyKey: 'idem-nightly',
		status: 'running',
	})
	await upsertWorkflow(userId, 'wf-creating', {
		idempotencyKey: 'idem-creating',
		runAt: '2026-07-31T01:00:00.000Z',
		status: 'creating',
	})
	await upsertWorkflow(userId, 'wf-done', {
		...nightly,
		runAt: '2026-07-30T00:00:00.000Z',
		status: 'complete',
		completedAt: '2026-07-30T00:01:00.000Z',
	})

	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-active-1' }),
	).toMatchObject({
		id: 'wf-active-1',
		bindingName: dynamicBinding,
		workflowName: 'nightly',
		status: 'running',
		packageId: 'pkg-1',
	})

	const findByKey = (idempotencyKey: string, bindingName?: string) =>
		findWorkflowProjectionByIdempotencyKey({
			env,
			userId,
			idempotencyKey,
			bindingName,
		})
	const findByBindingKey = (bindingName: string) =>
		findWorkflowProjectionByBindingIdempotencyKey({
			env,
			userId,
			bindingName,
			idempotencyKey: 'idem-creating',
		})
	expect(await findByKey('idem-nightly')).toMatchObject({ id: 'wf-active-1' })
	expect(await findByKey('idem-creating')).toBeNull()
	expect(await findByKey('idem-creating', dynamicBinding)).toBeNull()
	expect(await findByBindingKey(dynamicBinding)).toMatchObject({
		id: 'wf-creating',
		status: 'creating',
		idempotencyKey: 'idem-creating',
	})
	expect(await findByBindingKey('OTHER_WORKFLOWS')).toBeNull()

	expect(await countActiveWorkflowProjections({ env, userId })).toBe(1)

	await upsertWorkflow(userId, 'wf-active-1', {
		...nightly,
		idempotencyKey: 'idem-nightly',
		status: 'queued',
	})
	await upsertWorkflow(userId, 'wf-active-2', {
		bindingName: 'OTHER_WORKFLOWS',
		workflowName: 'other',
		runAt: '2026-07-31T02:00:00.000Z',
		status: 'waiting',
	})
	expect(await countActiveWorkflowProjections({ env, userId })).toBe(2)

	const listed = await listWorkflowProjections({ env, userId, limit: 10 })
	expect(listed.projections.map((row) => row.id).sort()).toEqual([
		'wf-active-1',
		'wf-active-2',
		'wf-creating',
		'wf-done',
	])
	expect(
		listed.projections.find((row) => row.id === 'wf-active-2')?.bindingName,
	).toBe('OTHER_WORKFLOWS')
})

test('reserveWorkflowProjectionSlot serializes concurrent creating, prunes stale, and never overwrites terminal', async () => {
	const userId = uniqueUserId('wf-reserve')
	const reserve = (
		reserveUserId: string,
		id: string,
		overrides?: Partial<WorkflowProjectionUpsertInput>,
	) =>
		reserveWorkflowProjectionSlot({
			env,
			userId: ownerIdFromStored(reserveUserId),
			projection: workflow(id, { status: 'creating', ...overrides }),
		})
	const results = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			reserve(userId, `wf-reserve-${index}`),
		),
	)
	expect(
		results
			.map((result) => result.countBeforeReservation)
			.sort((left, right) => left - right),
	).toEqual([0, 1, 2, 3, 4])
	expect(results.every((result) => result.reserved && result.inserted)).toBe(
		true,
	)

	const oneSlotLimit = 1
	await Promise.all(
		results.map(async (result) => {
			if (result.countBeforeReservation + 1 > oneSlotLimit) {
				await deleteWorkflowProjectionIfCreating({
					env,
					userId,
					id: result.projection.id,
				})
			}
		}),
	)
	const remaining = await listWorkflowProjections({
		env,
		userId,
		status: 'creating',
		limit: 10,
	})
	expect(remaining.projections.map((row) => row.id)).toEqual([
		results.find((result) => result.countBeforeReservation === 0)?.projection
			.id,
	])

	const ttlUserId = uniqueUserId('wf-reserve-ttl')
	const staleAt = new Date(
		Date.now() - workflowProjectionCreatingTtlMs - 60_000,
	).toISOString()
	const terminalAt = '2026-07-31T00:00:00.000Z'
	await upsertWorkflow(ttlUserId, 'wf-stale-creating', {
		workflowName: 'stale',
		runAt: staleAt,
		status: 'creating',
		createdAt: staleAt,
		updatedAt: staleAt,
	})
	await upsertWorkflow(ttlUserId, 'wf-terminal', {
		workflowName: 'done',
		status: 'complete',
		createdAt: terminalAt,
		updatedAt: terminalAt,
		completedAt: terminalAt,
	})

	const fresh = { workflowName: 'fresh', runAt: '2026-07-31T01:00:00.000Z' }
	const recovered = await reserve(ttlUserId, 'wf-fresh', fresh)
	// Stale creating pruned before count, so the fresh reserve sees an empty slot.
	expect(recovered).toMatchObject({
		countBeforeReservation: 0,
		reserved: true,
		inserted: true,
	})
	expect(
		await getWorkflowProjection({
			env,
			userId: ttlUserId,
			id: 'wf-stale-creating',
		}),
	).toBeNull()

	expect(
		await reserve(ttlUserId, 'wf-terminal', {
			workflowName: 'should-not-clobber',
			runAt: '2026-07-31T02:00:00.000Z',
		}),
	).toMatchObject({
		reserved: false,
		inserted: false,
		projection: expect.objectContaining({
			id: 'wf-terminal',
			status: 'complete',
			workflowName: 'done',
		}),
	})

	expect(await reserve(ttlUserId, 'wf-fresh', fresh)).toMatchObject({
		countBeforeReservation: 0,
		reserved: true,
		inserted: false,
	})
})

test('workflow projection upsert keeps terminal status sticky against newer active/creating', async () => {
	const userId = uniqueUserId('wf-terminal-sticky')
	const terminalAt = '2026-07-31T20:00:00.000Z'
	const newerAt = '2026-07-31T20:00:01.000Z'
	const write = (
		id: string,
		status: string,
		updatedAt: string,
		completedAt: string | null,
	) =>
		upsertWorkflow(userId, id, {
			idempotencyKey: `${id}-key`,
			runAt: updatedAt,
			status,
			createdAt: terminalAt,
			updatedAt,
			completedAt,
		})

	for (const terminalStatus of ['cancelled', 'complete'] as const) {
		const id = `wf-${terminalStatus}`
		await write(id, terminalStatus, terminalAt, terminalAt)
		for (const regressStatus of ['queued', 'running', 'creating'] as const) {
			await write(id, regressStatus, newerAt, null)
			expect(await getWorkflowProjection({ env, userId, id })).toMatchObject({
				status: terminalStatus,
				updatedAt: terminalAt,
				completedAt: terminalAt,
			})
		}
	}

	// Terminal → terminal with a newer updatedAt remains allowed.
	await write('wf-cancelled', 'complete', newerAt, newerAt)
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-cancelled' }),
	).toMatchObject({
		status: 'complete',
		updatedAt: newerAt,
		completedAt: newerAt,
	})
})

test('job run observability upserts terminal outcomes and supports batch reads', async () => {
	const userId = uniqueUserId('jobs')
	const upsert = (outcome: {
		jobId: string
		status: 'success' | 'error'
		ranAt: string
		durationMs: number
		error?: string
	}) => upsertJobRunObservability({ env, userId, outcome })
	expect(
		await upsert({
			jobId: 'job-a',
			status: 'success',
			ranAt: '2026-07-31T10:00:00.000Z',
			durationMs: 120,
		}),
	).toMatchObject({
		jobId: 'job-a',
		lastRunAt: '2026-07-31T10:00:00.000Z',
		lastRunStatus: 'success',
		lastRunError: null,
		lastDurationMs: 120,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
	})
	expect(
		await upsert({
			jobId: 'job-a',
			status: 'error',
			ranAt: '2026-07-31T11:00:00.000Z',
			error: 'boom',
			durationMs: 40,
		}),
	).toMatchObject({
		jobId: 'job-a',
		lastRunAt: '2026-07-31T11:00:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'boom',
		lastDurationMs: 40,
		runCount: 2,
		successCount: 1,
		errorCount: 1,
	})
	await upsert({
		jobId: 'job-b',
		status: 'success',
		ranAt: '2026-07-31T12:00:00.000Z',
		durationMs: 10,
	})

	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-a' }),
	).toMatchObject({ runCount: 2, errorCount: 1 })
	const batch = await getJobRunObservabilityBatch({
		env,
		userId,
		jobIds: ['job-b', 'job-a', 'missing'],
	})
	expect(batch.map((row) => row.jobId)).toEqual(['job-a', 'job-b'])
})

test('finishRun updates job observability for success/error and ignores replay', async () => {
	const userId = uniqueUserId('jobs-finish')
	const context: RunRecordContext = {
		surface: 'job',
		name: 'daily',
		jobId: 'job-finish',
		packageId: 'pkg-job',
	}
	const observed = () =>
		getJobRunObservability({ env, userId, jobId: 'job-finish' })

	const successHandle = beginRunRecord({ env, userId, context })
	expect(successHandle).not.toBeNull()
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['ok'],
	})
	const afterSuccess = await observed()
	expect(afterSuccess).toMatchObject({
		jobId: 'job-finish',
		lastRunStatus: 'success',
		lastRunError: null,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
	})
	expect(afterSuccess?.lastDurationMs).toBeGreaterThanOrEqual(0)
	expect(afterSuccess?.lastRunAt).toEqual(expect.any(String))

	// Replayed terminal finish of the same run must not double-count.
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		logs: ['replay'],
	})
	expect(await observed()).toMatchObject({
		runCount: 1,
		successCount: 1,
		errorCount: 0,
		lastRunStatus: 'success',
	})

	const errorHandle = beginRunRecord({ env, userId, context })
	const finishError = (message: string) =>
		finishRunRecord({
			env,
			handle: errorHandle,
			status: 'error',
			error: new Error(message),
		})
	await finishError('job blew up')
	expect(await observed()).toMatchObject({
		jobId: 'job-finish',
		lastRunStatus: 'error',
		lastRunError: 'job blew up',
		runCount: 2,
		successCount: 1,
		errorCount: 1,
	})

	await finishError('job blew up again')
	expect(await observed()).toMatchObject({
		runCount: 2,
		successCount: 1,
		errorCount: 1,
		// Replay keeps the first terminal error message.
		lastRunError: 'job blew up',
	})

	// Without jobId, finish must not invent observability rows.
	await finishBegunRun(userId, {
		surface: 'job',
		name: 'no-job-id',
		packageId: 'pkg-job',
	})
	expect(
		await getJobRunObservabilityBatch({
			env,
			userId,
			jobIds: ['job-finish'],
		}),
	).toHaveLength(1)
})

test('activation counts same-package successes, excludes HTTP surfaces, and is idempotent on replay', async () => {
	const userId = uniqueUserId('activation')

	async function finishSuccess(
		packageId: string,
		surface: RunRecordContext['surface'],
	) {
		const handle = beginRunRecord({
			env,
			userId,
			context: { surface, name: `${surface}-${packageId}`, packageId },
		})
		expect(handle).not.toBeNull()
		await finishRunRecord({ env, handle, status: 'success', logs: ['ok'] })
		return handle!
	}
	const expectSuccesses = async (
		counts: Array<[packageId: string, successCount: number]>,
		forUserId = userId,
	) =>
		expect(await listPackageRunSuccesses({ env, userId: forUserId })).toEqual(
			counts.map(([packageId, successCount]) =>
				expect.objectContaining({ packageId, successCount }),
			),
		)
	const expectMilestones = async (milestones: Array<string>) =>
		expect(await listActivationMilestones({ env, userId })).toEqual(
			milestones.map((milestone) =>
				expect.objectContaining({ milestone, packageId: 'pkg-a' }),
			),
		)

	const first = await finishSuccess('pkg-a', 'job')
	await expectSuccesses([['pkg-a', 1]])
	await expectMilestones(['package_run_succeeded'])

	// Replay/replacement of the same terminal success must not re-count.
	await finishRunRecord({
		env,
		handle: first,
		status: 'success',
		logs: ['replay'],
	})
	await expectSuccesses([['pkg-a', 1]])

	await finishSuccess('pkg-b', 'subscription')
	await expectSuccesses([
		['pkg-a', 1],
		['pkg-b', 1],
	])
	await expectMilestones(['package_run_succeeded'])

	await finishSuccess('pkg-a', 'webhook')
	await finishSuccess('pkg-a', 'app_fetch')
	await expectSuccesses([
		['pkg-a', 1],
		['pkg-b', 1],
	])

	await finishSuccess('pkg-a', 'workflow')
	await expectSuccesses([
		['pkg-a', 2],
		['pkg-b', 1],
	])
	await expectMilestones(['package_activated', 'package_run_succeeded'])

	// Global package_activated latch: further successes must not change counters.
	await finishSuccess('pkg-a', 'job')
	await finishSuccess('pkg-b', 'job')
	await finishSuccess('pkg-c', 'workflow')
	await expectSuccesses([
		['pkg-a', 2],
		['pkg-b', 1],
	])
	await expectMilestones(['package_activated', 'package_run_succeeded'])

	// Keyed package invocation finish also activates once, and fencing stays intact.
	const claimUser = uniqueUserId('activation-invoke')
	const finishInvocation = await claimInvocation(
		claimUser,
		'pkg-invoke',
		'evt-1',
	)
	expect((await finishInvocation()).ledgerUpdated).toBe(true)
	await expectSuccesses([['pkg-invoke', 1]], claimUser)
	await finishInvocation()
	await expectSuccesses([['pkg-invoke', 1]], claimUser)
})

test('retention prunes runs but never dedicated workflow/job/activation state', async () => {
	const userId = uniqueUserId('retention')

	// Recent terminal projection (within the 90-day workflow lane) plus job /
	// activation counters: run age/excess prune must not remove them.
	const recentWorkflowAt = new Date(Date.now() - 2 * dayMs).toISOString()
	await upsertWorkflow(userId, 'wf-keep', {
		workflowName: 'keep',
		runAt: recentWorkflowAt,
		status: 'complete',
		createdAt: recentWorkflowAt,
		updatedAt: recentWorkflowAt,
		completedAt: recentWorkflowAt,
	})
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-keep',
			status: 'success',
			ranAt: recentWorkflowAt,
			durationMs: 5,
		},
	})

	// One retention pass runs both lanes: after the 5 aged rows are age-pruned,
	// the fresh rows still exceed the cap, so excess prune runs too.
	const agedStartedAt = new Date(Date.now() - 40 * dayMs).toISOString()
	const freshStartedAt = new Date().toISOString()
	const excessCount = runRecordMaxRunsPerUser + 10
	await runInDurableObject(
		runLogStub(userId),
		async (instance: RunLog, state) => {
			expect(instance).toBeInstanceOf(RunLog)
			for (let i = 0; i < 5; i += 1) {
				insertAgedRun(state, { id: `aged-${i}`, startedAt: agedStartedAt })
			}
			for (let i = 0; i < excessCount; i += 1) {
				insertAgedRun(state, {
					id: `excess-${String(i).padStart(4, '0')}`,
					startedAt: freshStartedAt,
				})
			}
		},
	)
	await armRetentionOnNextFinish(userId, 5 + excessCount)
	await finishBegunRun(userId, {
		surface: 'job',
		name: 'trigger-retention',
		packageId: 'pkg-keep',
	})

	const countRuns = (where: string) =>
		runInDurableObject(
			runLogStub(userId),
			async (_instance: RunLog, state) =>
				state.storage.sql
					.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE ${where}`)
					.one().n,
		)
	expect(await countRuns(`id LIKE 'aged-%'`)).toBe(0)
	expect(await countRuns('1 = 1')).toBe(runRecordMaxRunsPerUser)
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-keep' }),
	).toMatchObject({ id: 'wf-keep', bindingName: dynamicBinding })
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-keep' }),
	).toMatchObject({ jobId: 'job-keep', successCount: 1 })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-keep', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		expect.objectContaining({ milestone: 'package_run_succeeded' }),
	])
})

const emptyExport = {
	runs: [],
	packageInvocations: [],
	workflowProjections: [],
	jobRunObservability: [],
	packageRunSuccesses: [],
	activationMilestones: [],
	truncated: false,
	nextStartAfter: null,
}

test('export pages dedicated state after runs and ledger; clearAll purges and reinitializes it', async () => {
	const userId = uniqueUserId('export')

	for (const name of ['export-run', 'export-run-2']) {
		await finishBegunRun(userId, {
			surface: 'job',
			name,
			packageId: 'pkg-export',
		})
	}
	await (
		await claimInvocation(userId, 'pkg-export', 'export-evt')
	)()
	await upsertWorkflow(userId, 'wf-export', {
		workflowName: 'export-wf',
		status: 'complete',
	})
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-export',
			status: 'success',
			ranAt: '2026-07-31T00:00:00.000Z',
			durationMs: 3,
		},
	})

	const seen = {
		runs: new Set<string>(),
		ledger: new Set<string>(),
		workflows: new Set<string>(),
		jobs: new Set<string>(),
		successes: new Set<string>(),
		milestones: new Set<string>(),
	}
	let startAfter: string | null = null
	for (let page = 0; page < 20; page += 1) {
		const exported = await exportRunRecords({
			env,
			userId,
			pageSize: 2,
			startAfter,
		})
		for (const run of exported.runs) seen.runs.add(run.id)
		for (const row of exported.packageInvocations) seen.ledger.add(row.id)
		for (const row of exported.workflowProjections) seen.workflows.add(row.id)
		for (const row of exported.jobRunObservability) seen.jobs.add(row.jobId)
		for (const row of exported.packageRunSuccesses) {
			seen.successes.add(row.packageId)
		}
		for (const row of exported.activationMilestones) {
			seen.milestones.add(row.milestone)
		}
		if (!exported.truncated) break
		startAfter = exported.nextStartAfter
	}

	expect(seen.runs.size).toBeGreaterThanOrEqual(3)
	expect(seen.ledger.size).toBe(1)
	expect([...seen.workflows]).toContain('wf-export')
	expect([...seen.jobs]).toContain('job-export')
	expect([...seen.successes]).toContain('pkg-export')
	expect([...seen.milestones]).toEqual(
		expect.arrayContaining(['package_run_succeeded', 'package_activated']),
	)

	// Old raw run-id cursor remains valid (resumes runs phase).
	const firstRunId = [...seen.runs].sort()[0]!
	const fromRunCursor = await exportRunRecords({
		env,
		userId,
		pageSize: 50,
		startAfter: firstRunId,
	})
	expect(fromRunCursor.runs.every((run) => run.id > firstRunId)).toBe(true)

	await clearRunRecords({ env, userId })
	expect(await exportRunRecords({ env, userId, pageSize: 50 })).toMatchObject(
		emptyExport,
	)
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-export' }),
	).toBeNull()
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-export' }),
	).toBeNull()
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([])
	expect(await listActivationMilestones({ env, userId })).toEqual([])
	expect(await countActiveWorkflowProjections({ env, userId })).toBe(0)

	// Reinitialized schema accepts new dedicated writes after clearAll.
	await upsertWorkflow(userId, 'wf-after-clear', {
		workflowName: 'fresh',
		runAt: '2026-07-31T03:00:00.000Z',
		status: 'queued',
	})
	expect(
		await getWorkflowProjection({ env, userId, id: 'wf-after-clear' }),
	).toMatchObject({ id: 'wf-after-clear', status: 'queued' })
})

test('export cursors always make progress across phase handoffs and empty tails', async () => {
	const userId = uniqueUserId('export-progress')

	// Exactly pageSize runs so the first page hands off with remaining=0.
	for (let i = 0; i < 2; i += 1) {
		await finishBegunRun(userId, {
			surface: 'job',
			name: `run-${i}`,
			jobId: `job-progress-${i}`,
			packageId: 'pkg-progress',
		})
	}
	await upsertWorkflow(userId, 'wf-progress', {
		workflowName: 'progress',
		status: 'complete',
	})

	const cursors: Array<string> = []
	let startAfter: string | null = null
	let sawWorkflow = false
	let sawJob = false
	for (let page = 0; page < 12; page += 1) {
		const exported = await exportRunRecords({
			env,
			userId,
			pageSize: 2,
			startAfter,
		})
		if (exported.workflowProjections.length > 0) sawWorkflow = true
		if (exported.jobRunObservability.length > 0) sawJob = true
		// Truncated pages must advance the cursor; repeating one spins clients.
		if (exported.truncated) {
			expect(exported.nextStartAfter).not.toBeNull()
			expect(exported.nextStartAfter).not.toBe(startAfter)
			startAfter = exported.nextStartAfter
			cursors.push(startAfter!)
			continue
		}
		expect(exported.nextStartAfter).toBeNull()
		break
	}
	expect(sawWorkflow).toBe(true)
	expect(sawJob).toBe(true)
	expect(new Set(cursors).size).toBe(cursors.length)

	// Prefixed cursors past all remaining rows must terminate (not re-emit).
	const emptyUser = uniqueUserId('export-empty-tail')
	for (const emptyTail of [
		'invocation-ledger:',
		'workflow-projections:',
		'job-run-observability:',
		'package-run-successes:',
		'activation-milestones:',
		'activation-milestones:zzz',
	]) {
		expect(
			await exportRunRecords({
				env,
				userId: emptyUser,
				pageSize: 2,
				startAfter: emptyTail,
			}),
		).toMatchObject(emptyExport)
	}
})

test('fresh schema v13 creates run_day_counts beside job_run_observability', async () => {
	const userId = uniqueUserId('schema-v13-fresh')
	await runInDurableObject(
		runLogStub(userId),
		async (instance: RunLog, state) => {
			expect(instance).toBeInstanceOf(RunLog)
			expect(schemaVersion(state)).toBe(13)
			expect(columnNames(state, 'job_run_observability')).toEqual(
				jobRunObservabilityColumns,
			)
			expect(columnNames(state, 'runs')).toEqual(
				expect.arrayContaining(runsTriageColumns),
			)
			expect(columnNames(state, 'package_invocation_ledger')).toEqual(
				expect.arrayContaining(['claim_owner']),
			)
			expect(columnNames(state, 'run_day_counts')).toEqual([
				'day',
				'surface',
				'status',
				'count',
			])
			expect(
				state.storage.sql
					.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_day_counts`)
					.one().n,
			).toBe(0)
		},
	)

	const updated = await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'job-v10',
			status: 'error',
			ranAt: '2026-08-01T01:00:00.000Z',
			error: 'fresh-v10',
		},
	})
	expect(updated).toMatchObject({
		jobId: 'job-v10',
		runCount: 1,
		successCount: 0,
		errorCount: 1,
		lastRunStatus: 'error',
		lastRunError: 'fresh-v10',
	})
})

test('warm schema v12 objects upgrade to v13 with an empty run_day_counts table', async () => {
	const userId = uniqueUserId('schema-v12-warm-day-counts')
	await upgradeFromLegacySchema(
		userId,
		12,
		(state) => {
			state.storage.sql.exec(`
				CREATE TABLE runs (
					id TEXT PRIMARY KEY NOT NULL,
					surface TEXT NOT NULL,
					status TEXT NOT NULL,
					name TEXT,
					package_id TEXT,
					package_kody_id TEXT,
					source_id TEXT,
					published_commit TEXT,
					storage_id TEXT,
					job_id TEXT,
					workflow_id TEXT,
					invocation_id TEXT,
					session_id TEXT,
					idempotency_key TEXT,
					parent_run_id TEXT,
					started_at TEXT NOT NULL,
					finished_at TEXT,
					duration_ms INTEGER,
					error_name TEXT,
					error_message TEXT,
					metadata_json TEXT NOT NULL DEFAULT '{}',
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					error_triage TEXT,
					triage_note TEXT,
					triaged_at TEXT,
					triaged_by TEXT,
					log_count INTEGER NOT NULL DEFAULT 0
				)
			`)
			// Pre-deploy retained row: migration must not backfill day counts.
			state.storage.sql.exec(
				`INSERT INTO runs (
					id, surface, status, started_at, finished_at, metadata_json,
					created_at, updated_at, log_count
				) VALUES (?, 'execute', 'success', ?, ?, '{}', ?, ?, 0)`,
				'pre-deploy-run',
				'2026-10-01T00:00:00.000Z',
				'2026-10-01T00:00:01.000Z',
				'2026-10-01T00:00:00.000Z',
				'2026-10-01T00:00:01.000Z',
			)
		},
		(state) => {
			expect(columnNames(state, 'run_day_counts')).toEqual([
				'day',
				'surface',
				'status',
				'count',
			])
			expect(
				state.storage.sql
					.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM run_day_counts`)
					.one().n,
			).toBe(0)
			expect(
				state.storage.sql
					.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
					.one().n,
			).toBe(1)
		},
	)
})

test('warm schema v7 and v8 objects upgrade to v13 without losing job data', async () => {
	const retiredColumn = ['legacy', 'seeded'].join('_')
	for (const installedVersion of [7, 8]) {
		const userId = uniqueUserId(`schema-v${installedVersion}-warm`)
		const jobId = `job-warm-v${installedVersion}`
		await upgradeFromLegacySchema(
			userId,
			installedVersion,
			(state) => {
				state.storage.sql.exec(`
					CREATE TABLE job_run_observability (
						job_id TEXT PRIMARY KEY NOT NULL,
						last_run_at TEXT,
						last_run_status TEXT,
						last_run_error TEXT,
						last_duration_ms INTEGER,
						run_count INTEGER NOT NULL DEFAULT 0,
						success_count INTEGER NOT NULL DEFAULT 0,
						error_count INTEGER NOT NULL DEFAULT 0,
						updated_at TEXT NOT NULL,
						${retiredColumn} INTEGER NOT NULL DEFAULT 0
					)
				`)
				state.storage.sql.exec(
					`INSERT INTO job_run_observability (
						job_id, last_run_at, last_run_status, last_run_error,
						last_duration_ms, run_count, success_count, error_count,
						updated_at, ${retiredColumn}
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
					jobId,
					'2026-07-01T00:00:00.000Z',
					'error',
					'preserved error',
					57,
					9,
					6,
					3,
					'2026-07-01T00:00:01.000Z',
				)
			},
			(state) => {
				expect(columnNames(state, 'job_run_observability')).toEqual(
					jobRunObservabilityColumns,
				)
				expect(
					state.storage.sql
						.exec<Record<string, SqlStorageValue>>(
							`SELECT * FROM job_run_observability WHERE job_id = ?`,
							jobId,
						)
						.one(),
				).toEqual({
					job_id: jobId,
					last_run_at: '2026-07-01T00:00:00.000Z',
					last_run_status: 'error',
					last_run_error: 'preserved error',
					last_duration_ms: 57,
					run_count: 9,
					success_count: 6,
					error_count: 3,
					updated_at: '2026-07-01T00:00:01.000Z',
				})
			},
		)

		await expect(
			getJobRunObservability({ env, userId, jobId }),
		).resolves.toMatchObject({
			jobId,
			runCount: 9,
			successCount: 6,
			errorCount: 3,
			lastRunStatus: 'error',
			lastRunError: 'preserved error',
		})
	}
})

test('warm schema v9 objects upgrade to v13 with error triage and log_count columns', async () => {
	await upgradeFromLegacySchema(
		uniqueUserId('schema-v9-warm-triage'),
		9,
		(state) => {
			state.storage.sql.exec(`CREATE TABLE runs (${legacyRunsColumnsDdl})`)
			state.storage.sql.exec(
				`INSERT INTO runs (
					id, surface, status, name, started_at, finished_at, duration_ms,
					error_name, error_message, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
				'run-warm-v9',
				'execute',
				'error',
				'warm-v9',
				'2026-07-01T00:00:00.000Z',
				'2026-07-01T00:00:01.000Z',
				1000,
				'Error',
				'preserved',
				'2026-07-01T00:00:00.000Z',
				'2026-07-01T00:00:01.000Z',
			)
		},
		(state) => {
			expect(columnNames(state, 'runs')).toEqual(
				expect.arrayContaining(runsTriageColumns),
			)
			expect(
				state.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT id, status, error_message, error_triage, triage_note, log_count
						FROM runs WHERE id = ?`,
						'run-warm-v9',
					)
					.one(),
			).toEqual({
				id: 'run-warm-v9',
				status: 'error',
				error_message: 'preserved',
				error_triage: null,
				triage_note: null,
				log_count: 0,
			})
		},
	)
})

test('warm schema v10 objects backfill denormalized log_count on upgrade to v13', async () => {
	const userId = uniqueUserId('schema-v10-warm-log-count')
	await upgradeFromLegacySchema(
		userId,
		10,
		(state) => {
			state.storage.sql.exec(`
				CREATE TABLE runs (${legacyRunsColumnsDdl},
					error_triage TEXT, triage_note TEXT, triaged_at TEXT, triaged_by TEXT)
			`)
			state.storage.sql.exec(`
				CREATE TABLE run_logs (
					run_id TEXT NOT NULL,
					sequence INTEGER NOT NULL,
					level TEXT NOT NULL,
					message TEXT NOT NULL,
					fields_json TEXT,
					PRIMARY KEY (run_id, sequence)
				)
			`)
			state.storage.sql.exec(
				`INSERT INTO runs (
					id, surface, status, name, started_at, finished_at, duration_ms,
					error_name, error_message, metadata_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}', ?, ?)`,
				'run-warm-v10',
				'execute',
				'success',
				'warm-v10',
				'2026-07-01T00:00:00.000Z',
				'2026-07-01T00:00:01.000Z',
				1000,
				'2026-07-01T00:00:00.000Z',
				'2026-07-01T00:00:01.000Z',
			)
			state.storage.sql.exec(
				`INSERT INTO run_logs (run_id, sequence, level, message, fields_json)
				VALUES (?, 0, 'info', 'a', NULL), (?, 1, 'info', 'b', NULL), (?, 2, 'info', 'c', NULL)`,
				'run-warm-v10',
				'run-warm-v10',
				'run-warm-v10',
			)
		},
		(state) => {
			expect(
				state.storage.sql
					.exec<{ log_count: number }>(
						`SELECT log_count FROM runs WHERE id = ?`,
						'run-warm-v10',
					)
					.one(),
			).toEqual({ log_count: 3 })
		},
	)

	expect((await listRunRecords({ env, userId })).runs).toEqual([
		expect.objectContaining({ logCount: 3 }),
	])
})

test('warm schema v11 objects gain claim_owner on upgrade to v13', async () => {
	await upgradeFromLegacySchema(
		uniqueUserId('schema-v11-warm-claim-owner'),
		11,
		(state) => {
			state.storage.sql.exec(`
				CREATE TABLE package_invocation_ledger (
					id TEXT PRIMARY KEY NOT NULL,
					token_id TEXT NOT NULL,
					package_id TEXT NOT NULL,
					package_kody_id TEXT NOT NULL,
					export_name TEXT NOT NULL,
					idempotency_key TEXT NOT NULL,
					request_hash TEXT NOT NULL,
					source TEXT,
					topic TEXT,
					status TEXT NOT NULL,
					response_json TEXT,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`)
			state.storage.sql.exec(
				`INSERT INTO package_invocation_ledger (
					id, token_id, package_id, package_kody_id, export_name,
					idempotency_key, request_hash, source, topic, status,
					response_json, created_at, updated_at
				) VALUES (?, 'token-1', 'pkg-1', 'pkg-one', './export',
					'evt-warm-v11', 'hash-1', NULL, NULL, 'completed',
					NULL, ?, ?)`,
				'inv-warm-v11',
				'2026-07-01T00:00:00.000Z',
				'2026-07-01T00:00:01.000Z',
			)
		},
		(state) => {
			expect(columnNames(state, 'package_invocation_ledger')).toEqual(
				expect.arrayContaining(['claim_owner']),
			)
			expect(
				state.storage.sql
					.exec<Record<string, SqlStorageValue>>(
						`SELECT id, status, claim_owner FROM package_invocation_ledger
						WHERE id = ?`,
						'inv-warm-v11',
					)
					.one(),
			).toEqual({
				id: 'inv-warm-v11',
				status: 'completed',
				claim_owner: null,
			})
		},
	)
})

test('getAdminInsightsSnapshot returns content-free workflow, job, and activation aggregates', async () => {
	const userId = uniqueUserId('admin-insights')
	const reachedAt = '2026-08-01T12:00:00.000Z'
	const at = { runAt: reachedAt, createdAt: reachedAt, updatedAt: reachedAt }

	await upsertWorkflow(userId, 'wf-running-1', {
		...at,
		workflowName: 'secret-name-must-not-leak',
		status: 'running',
		lastError: 'secret-error-must-not-leak',
	})
	await upsertWorkflow(userId, 'wf-running-2', {
		...at,
		workflowName: 'other',
		status: 'running',
	})
	await upsertWorkflow(userId, 'wf-complete', {
		...at,
		workflowName: 'done',
		status: 'complete',
		completedAt: reachedAt,
	})
	await finishBegunRun(userId, {
		surface: 'job',
		name: 'activate',
		packageId: 'pkg-admin',
		jobId: 'job-admin',
	})
	await finishBegunRun(userId, {
		surface: 'job',
		name: 'activate-2',
		packageId: 'pkg-admin',
	})
	await upsertJobRunObservability({
		env,
		userId,
		outcome: {
			jobId: 'secret-job-must-not-leak',
			status: 'error',
			ranAt: reachedAt,
			error: 'secret-job-error-must-not-leak',
		},
	})

	const snapshot = await getAdminInsightsSnapshot({ env, userId })
	expect(Object.keys(snapshot).sort()).toEqual([
		'activationMilestones',
		'jobRunCounts',
		'workflowStatusCounts',
	])
	expect(snapshot.workflowStatusCounts).toEqual([
		{ status: 'running', count: 2 },
		{ status: 'complete', count: 1 },
	])
	expect(snapshot.activationMilestones).toEqual(
		['package_activated', 'package_run_succeeded'].map((milestone) => ({
			milestone,
			packageId: 'pkg-admin',
			reachedAt: expect.any(String),
		})),
	)
	expect(snapshot.jobRunCounts).toEqual({ success: 1, error: 1 })
	expect(JSON.stringify(snapshot)).not.toMatch(
		/secret-name-must-not-leak|secret-error-must-not-leak|secret-job-must-not-leak|secret-job-error-must-not-leak|job-admin|"name"|lastError|errorMessage|workflowName|"logs"/,
	)
})

test('getSqlBillingStats and inspectRunLogSqlBilling report listRuns/finishRun cost without leaking run content', async () => {
	const userId = uniqueUserId('sql-billing')
	const pending: Array<Promise<unknown>> = []
	const secretLog = 'secret-log-line-must-not-appear'
	const handle = beginRunRecord({
		env,
		userId,
		context: { surface: 'job', name: 'inspect-job', jobId: 'job-inspect' },
		waitUntil: (promise) => {
			pending.push(promise)
		},
	})
	expect(handle).not.toBeNull()
	await Promise.all(pending)
	await finishRunRecord({
		env,
		handle,
		status: 'success',
		logs: [secretLog, 'second-line'],
	})
	await listRunRecords({ env, userId })

	const stats = await getSqlBillingStats({ env, userId })
	expect(stats.databaseSize).toBeGreaterThan(0)
	expect(stats.rowsReadTotal).toBeGreaterThan(0)
	expect(stats.ops.some((op) => op.op === 'listRuns' && op.calls >= 1)).toBe(
		true,
	)
	expect(stats.ops.some((op) => op.op === 'finishRun' && op.calls >= 1)).toBe(
		true,
	)

	const inspection = await inspectRunLogSqlBilling({ env, userId })
	expect(inspection.schemaVersion).toBe(13)
	expect(inspection.tableCounts.runs).toBeGreaterThanOrEqual(1)
	expect(inspection.tableCounts.runLogs).toBeGreaterThanOrEqual(1)
	expect(inspection.runCount.actual).toBe(inspection.tableCounts.runs)
	expect(inspection.runCount.matches).toBe(true)
	expect(
		inspection.runLogsColumns.some(
			(column) => column.name === 'run_id' && column.pk >= 1,
		),
	).toBe(true)
	expect(inspection.runLogsIndexes.length).toBeGreaterThan(0)
	for (const plan of [
		inspection.explainRunLogsSelectByRunId,
		inspection.explainRunLogsDeleteByRunId,
	]) {
		expect(
			plan.some((step) => step.detail.toLowerCase().includes('run_logs')),
		).toBe(true)
	}
	const serialized = JSON.stringify(inspection)
	expect(serialized).not.toContain(secretLog)
	expect(serialized).not.toContain('inspect-job')
})
