import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { RunLog } from './run-log-do.ts'
import { seedRunLogMeta } from './run-log-meta-test-seed.ts'
import {
	finishRunRecord,
	beginRunRecord,
	getJobRunObservability,
	getWorkflowProjection,
	listActivationMilestones,
	listPackageRunSuccesses,
	upsertWorkflowProjection,
} from './service.ts'
import {
	runRecordRetentionEveryNFinishes,
	workflowProjectionRetentionDays,
} from './types.ts'

function uniqueUserId(label: string): OwnerId {
	return ownerIdFromStored(`runlog-continuity-${label}-${crypto.randomUUID()}`)
}

function runLogStub(userId: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(namespace.idFromName(userId))
}

function silenceExpectedConsoleWarns(substrings: Array<string>) {
	silenceIncidentalRuntimeWarnings()
	consoleWarn.mockImplementation((...args: Array<unknown>) => {
		const message = String(args[0] ?? '')
		if (substrings.some((part) => message.includes(part))) return
	})
}

async function armRetentionOnNextFinish(userId: string) {
	const stub = runLogStub(userId)
	await runInDurableObject(stub, async (instance: RunLog) => {
		expect(instance).toBeInstanceOf(RunLog)
		seedRunLogMeta(instance, {
			finishesSinceRetention: runRecordRetentionEveryNFinishes - 1,
		})
	})
}

function finishRun(
	userId: string,
	context: Parameters<typeof beginRunRecord>[0]['context'],
	status: 'success' | 'error' = 'success',
	error?: Error,
	runEnv: Env = env,
) {
	return finishRunRecord({
		env: runEnv,
		handle: beginRunRecord({
			env: runEnv,
			userId: ownerIdFromStored(userId),
			context,
		}),
		status,
		error,
	})
}

function upsertWorkflow(
	userId: string,
	projection: Partial<
		Parameters<typeof upsertWorkflowProjection>[0]['projection']
	> & { id: string; runAt: string; status: string },
) {
	return upsertWorkflowProjection({
		env,
		userId: ownerIdFromStored(userId),
		projection: {
			bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
			sourceType: 'inline',
			workflowName: projection.id,
			idempotencyKey: `idem-${projection.id}`,
			createdAt: projection.runAt,
			updatedAt: projection.runAt,
			...projection,
		} as Parameters<typeof upsertWorkflowProjection>[0]['projection'],
	})
}

const activationMilestone = (milestone: string, packageId: string) =>
	expect.objectContaining({ milestone, packageId })

test('activation milestones accumulate from zero across terminal finishes', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('activation-from-zero')
	const context = { surface: 'job', packageId: 'pkg-seed' } as const

	await finishRun(userId, { ...context, name: 'first-success' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		activationMilestone('package_run_succeeded', 'pkg-seed'),
	])

	await finishRun(userId, { ...context, name: 'second-success' })
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-seed', successCount: 2 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		activationMilestone('package_activated', 'pkg-seed'),
		activationMilestone('package_run_succeeded', 'pkg-seed'),
	])
})

test('job observability counters start from zero on first terminal finish', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('job-from-zero')
	const jobId = `job-${crypto.randomUUID()}`

	await finishRun(
		userId,
		{ surface: 'job', name: 'first', jobId },
		'error',
		new Error('new failure'),
	)
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		jobId,
		runCount: 1,
		successCount: 0,
		errorCount: 1,
		lastRunStatus: 'error',
		lastRunError: 'new failure',
	})
	await finishRun(userId, { surface: 'job', name: 'second', jobId })
	expect(await getJobRunObservability({ env, userId, jobId })).toMatchObject({
		runCount: 2,
		successCount: 1,
		errorCount: 1,
		lastRunStatus: 'success',
	})
})

test('finishRun rolls back run upsert when a later terminal side effect throws', async () => {
	const userId = uniqueUserId('finish-tx')
	const stub = runLogStub(userId)
	const runId = crypto.randomUUID()
	await runInDurableObject(stub, async (instance: RunLog, state) => {
		expect(instance).toBeInstanceOf(RunLog)
		const proto = Object.getPrototypeOf(instance) as {
			recordTerminalRunSideEffects: (input: unknown) => void
		}
		const original = proto.recordTerminalRunSideEffects
		proto.recordTerminalRunSideEffects = () => {
			throw new Error('forced-finish-rollback')
		}
		try {
			await expect(
				instance.finishRun({
					run: {
						id: runId,
						surface: 'job',
						status: 'success',
						name: 'tx-fail',
						packageId: 'pkg-finish-tx',
						kodyId: null,
						sourceId: null,
						publishedCommit: null,
						storageId: null,
						jobId: 'job-finish-tx',
						workflowId: null,
						invocationId: null,
						sessionId: null,
						idempotencyKey: null,
						parentRunId: null,
						startedAt: '2026-07-31T00:00:00.000Z',
						finishedAt: '2026-07-31T00:00:01.000Z',
						durationMs: 1000,
						errorName: null,
						errorMessage: null,
						startedBy: null,
						metadataJson: '{}',
						createdAt: '2026-07-31T00:00:00.000Z',
						updatedAt: '2026-07-31T00:00:01.000Z',
					},
					logs: [],
				}),
			).rejects.toThrow('forced-finish-rollback')
		} finally {
			proto.recordTerminalRunSideEffects = original
		}
		const count = (query: string, ...bindings: Array<SqlStorageValue>) =>
			Number(state.storage.sql.exec<{ n: number }>(query, ...bindings).one().n)
		expect([
			count(`SELECT COUNT(*) AS n FROM runs WHERE id = ?`, runId),
			count(
				`SELECT COUNT(*) AS n FROM package_run_successes WHERE package_id = 'pkg-finish-tx'`,
			),
			count(
				`SELECT COUNT(*) AS n FROM job_run_observability WHERE job_id = 'job-finish-tx'`,
			),
		]).toEqual([0, 0, 0])
	})

	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	await finishRun(userId, {
		surface: 'job',
		name: 'tx-ok',
		packageId: 'pkg-tx-ok',
	})
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-tx-ok', successCount: 1 }),
	])
	expect(await listActivationMilestones({ env, userId })).toEqual([
		activationMilestone('package_run_succeeded', 'pkg-tx-ok'),
	])
})

test('workflow projection retention prunes old terminal rows but keeps active and unpruned dedicated state', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('wf-retention')
	const daysAgo = (days: number) =>
		new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
	const oldTerminalAt = daysAgo(workflowProjectionRetentionDays + 5)
	const oldActiveAt = daysAgo(workflowProjectionRetentionDays + 10)

	await upsertWorkflow(userId, {
		id: 'wf-old-terminal',
		runAt: oldTerminalAt,
		status: 'complete',
		completedAt: oldTerminalAt,
	})
	await upsertWorkflow(userId, {
		id: 'wf-old-active',
		runAt: oldActiveAt,
		status: 'running',
	})
	await upsertWorkflow(userId, {
		id: 'wf-old-creating',
		sourceType: 'package',
		packageId: 'pkg-keep',
		exportName: 'run',
		runAt: oldActiveAt,
		status: 'creating',
	})

	await finishRun(userId, {
		surface: 'job',
		name: 'keep-stats',
		jobId: 'job-keep-stats',
		packageId: 'pkg-keep-stats',
	})
	await armRetentionOnNextFinish(userId)
	await finishRun(userId, {
		surface: 'job',
		name: 'trigger-retention',
		packageId: 'pkg-keep-stats',
	})

	const projection = (id: string) => getWorkflowProjection({ env, userId, id })
	expect(await projection('wf-old-terminal')).toBeNull()
	expect(await projection('wf-old-active')).toMatchObject({
		id: 'wf-old-active',
		status: 'running',
	})
	expect(await projection('wf-old-creating')).toBeNull()

	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-keep-stats', successCount: 2 }),
	])
	expect(
		(await listActivationMilestones({ env, userId })).length,
	).toBeGreaterThan(0)
	expect(
		await getJobRunObservability({ env, userId, jobId: 'job-keep-stats' }),
	).toMatchObject({ jobId: 'job-keep-stats', successCount: 1 })
})

test('missing APP_DB does not affect terminal job/activation updates', async () => {
	silenceExpectedConsoleWarns(['activation-run-record-failed'])
	const userId = uniqueUserId('no-app-db')
	await finishRun(
		userId,
		{
			surface: 'job',
			name: 'degrade',
			jobId: 'missing-job',
			packageId: 'pkg-degrade',
		},
		'success',
		undefined,
		{ ...env, APP_DB: undefined } as unknown as Env,
	)
	expect(await listPackageRunSuccesses({ env, userId })).toEqual([
		expect.objectContaining({ packageId: 'pkg-degrade', successCount: 1 }),
	])
	expect(
		await getJobRunObservability({ env, userId, jobId: 'missing-job' }),
	).toMatchObject({
		jobId: 'missing-job',
		runCount: 1,
		successCount: 1,
	})
})
