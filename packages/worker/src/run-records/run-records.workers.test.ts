import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { runBundledModuleWithRegistry } from '#mcp/run-kody-registry.ts'
import { buildKodyModuleBundle } from '#worker/package-runtime/module-graph.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { RunLog } from './run-log-do.ts'
import { seedRunLogMeta } from './run-log-meta-test-seed.ts'
import {
	abandonRunRecord,
	beginRunRecord,
	claimPackageInvocationRecord,
	bulkUpdateRunErrorTriage,
	claimRunRecord,
	finishPackageInvocationRecord,
	finishRunRecord,
	getRunRecord,
	getRunRecordByIdempotencyKey,
	getSqlBillingStats,
	listRunRecords,
	recordRunRecord,
	runLogRpc,
	summarizeRunRecords,
	loadWorkspaceRunCharts,
	updateRunErrorTriage,
} from './service.ts'
import {
	runRecordMaxLogEntriesPerRun,
	runRecordMaxResultSnapshotBytes,
	runRecordMaxRunsPerUser,
	runRecordPlatformInterruptedErrorName,
	runRecordRetentionDays,
	runRecordRetentionEmptyBackoffMinMs,
	runRecordRetentionEveryNFinishes,
	runRecordStaleRunningTtlMsBackground,
	runRecordStaleRunningTtlMsJob,
	runRecordStaleRunningTtlMsScheduledJob,
	runRecordStaleRunningTtlMsShortLived,
	type RunRecordContext,
	type RunRecordFilter,
	type RunRecordHandle,
	type RunSurface,
} from './types.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'

type SeedRun = {
	id: string
	status: 'running' | 'success' | 'error'
	startedAt: string
	finishedAt?: string | null
	name?: string | null
	surface?: string
	jobId?: string | null
	errorName?: string | null
	errorMessage?: string | null
	errorTriage?: 'ignored' | 'resolved' | null
	idempotencyKey?: string | null
}

const dayMs = 24 * 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

function uniqueUserId(label: string): OwnerId {
	return ownerIdFromStored(`run-records-${label}-${crypto.randomUUID()}`)
}

function baseContext(overrides?: Partial<RunRecordContext>): RunRecordContext {
	return {
		surface: 'job',
		name: 'example-job',
		...overrides,
	}
}

function runLogStub(userId: string) {
	const namespace = env.RUN_LOG as DurableObjectNamespace<RunLog>
	return namespace.get(namespace.idFromName(userId))
}

function handleFor(
	userId: string,
	id: string,
	context?: Partial<RunRecordContext>,
	startedAtMs: number = Date.now(),
): RunRecordHandle {
	return {
		id,
		userId: ownerIdFromStored(userId),
		startedAt: iso(startedAtMs),
		persistence: 'eager',
		context: baseContext(context),
	}
}

function finishOk(
	userId: string,
	id: string,
	context?: Partial<RunRecordContext>,
	startedAtMs?: number,
) {
	return finishRunRecord({
		env,
		handle: handleFor(userId, id, context, startedAtMs),
		status: 'success',
	})
}

const getRun = (userId: string, runId: string) =>
	getRunRecord({ env, userId: ownerIdFromStored(userId), runId })

const listRuns = (userId: string, filter?: RunRecordFilter, limit?: number) =>
	listRunRecords({ env, userId: ownerIdFromStored(userId), filter, limit })

async function drainWaitUntil(pending: Array<Promise<unknown>>) {
	await Promise.all(pending)
	pending.length = 0
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

function insertRunRow(state: DurableObjectState, input: SeedRun) {
	const finishedAt = input.finishedAt ?? null
	state.storage.sql.exec(
		`INSERT INTO runs (
			id, surface, status, name, job_id, idempotency_key, started_at,
			finished_at, duration_ms, error_name, error_message, error_triage,
			metadata_json, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
		input.id,
		input.surface ?? 'job',
		input.status,
		input.name ?? null,
		input.jobId ?? null,
		input.idempotencyKey ?? null,
		input.startedAt,
		finishedAt,
		finishedAt == null ? null : 1,
		input.errorName ?? null,
		input.errorMessage ?? null,
		input.errorTriage ?? null,
		input.startedAt,
		finishedAt ?? input.startedAt,
	)
}

async function seedRuns(userId: string, rows: Array<SeedRun>) {
	await runInDurableObject(
		runLogStub(userId),
		async (instance: RunLog, state) => {
			expect(instance).toBeInstanceOf(RunLog)
			for (const row of rows) insertRunRow(state, row)
		},
	)
}

/** `count` finished rows `${prefix}-${index}` started `stepMs` apart. */
function finishedRows(
	prefix: string,
	count: number,
	startMs: number,
	row: Omit<SeedRun, 'id' | 'startedAt'>,
	stepMs = 1,
): Array<SeedRun> {
	return Array.from({ length: count }, (_, index) => {
		const startedAt = iso(startMs + index * stepMs)
		return {
			id: `${prefix}-${index}`,
			startedAt,
			finishedAt: startedAt,
			...row,
		}
	})
}

function sqlOne<T extends Record<string, SqlStorageValue>>(
	userId: string,
	query: string,
) {
	return runInDurableObject(
		runLogStub(userId),
		async (_instance: RunLog, state) => state.storage.sql.exec<T>(query).one(),
	)
}

async function countRuns(userId: string, where = '1 = 1') {
	return (
		await sqlOne<{ n: number }>(
			userId,
			`SELECT COUNT(*) AS n FROM runs WHERE ${where}`,
		)
	).n
}

function getAlarm(userId: string) {
	return runInDurableObject(
		runLogStub(userId),
		async (_instance: RunLog, state) => state.storage.getAlarm(),
	)
}

test('write surfaces journey', async () => {
	// --- eager begin/finish → success with log count ---
	const userId = uniqueUserId('write-surfaces')
	const pending: Array<Promise<unknown>> = []
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'job', jobId: 'job-1' }),
		waitUntil: (promise) => {
			pending.push(promise)
		},
	})
	expect(handle).not.toBeNull()
	await drainWaitUntil(pending)
	await finishRunRecord({ env, handle, status: 'success', logs: ['done'] })
	expect((await listRuns(userId)).runs).toEqual([
		expect.objectContaining({
			status: 'success',
			surface: 'job',
			jobId: 'job-1',
			logCount: 1,
		}),
	])

	// --- finish-only upsert when startRun never landed ---
	const userId2 = uniqueUserId('finish-only')
	const orphanHandle = handleFor(userId2, crypto.randomUUID(), {
		surface: 'workflow',
		workflowId: 'wf-1',
		name: 'solo-finish',
	})
	await finishRunRecord({
		env,
		handle: orphanHandle,
		status: 'success',
		logs: [{ level: 'info', message: 'finished without start' }],
	})
	const orphanDetail = await getRun(userId2, orphanHandle.id)
	expect(orphanDetail?.run).toMatchObject({
		status: 'success',
		surface: 'workflow',
		workflowId: 'wf-1',
	})
	expect(orphanDetail?.logs).toEqual([
		{
			runId: orphanHandle.id,
			sequence: 0,
			level: 'info',
			message: 'finished without start',
			fields: null,
		},
	])

	// --- recordRunRecord one-shot terminal write ---
	const userId3 = uniqueUserId('record-one-shot')
	const shotHandle = await recordRunRecord({
		env,
		userId: userId3,
		context: baseContext({ surface: 'webhook', name: 'hook-a' }),
		status: 'success',
		logs: ['delivered'],
	})
	const shotDetail = await getRun(userId3, shotHandle!.id)
	expect(shotDetail?.run).toMatchObject({
		status: 'success',
		surface: 'webhook',
		name: 'hook-a',
	})
	expect(shotDetail?.logs).toHaveLength(1)

	// --- finishRunRecord returns synchronously when waitUntil is provided ---
	const userId4 = uniqueUserId('finish-wait-until')
	const waitHandle = handleFor(userId4, crypto.randomUUID(), {
		surface: 'export',
		name: 'bg-finish',
	})
	const waitPending: Array<Promise<unknown>> = []
	const finishReturn = finishRunRecord({
		env,
		handle: waitHandle,
		status: 'success',
		logs: ['async'],
		waitUntil: (promise) => {
			waitPending.push(promise)
		},
	})
	await expect(finishReturn).resolves.toBe(true)
	expect(waitPending).toHaveLength(1)
	await drainWaitUntil(waitPending)
	expect((await getRun(userId4, waitHandle.id))?.run.status).toBe('success')

	// --- execute is eager (success and error persist); key-less export stays on-failure ---
	const userId5 = uniqueUserId('execute-policy')
	const successHandle = beginRunRecord({
		env,
		userId: userId5,
		context: baseContext({ surface: 'execute', name: 'ok' }),
	})
	expect(successHandle?.persistence).toBe('eager')
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
		result: { ok: true },
		logs: ['persisted'],
	})
	const successDetail = await getRun(userId5, successHandle!.id)
	expect(successDetail?.run).toMatchObject({
		status: 'success',
		surface: 'execute',
		name: 'ok',
		idempotencyKey: null,
	})
	expect(successDetail?.logs.map((entry) => entry.message)).toEqual([
		'persisted',
	])
	expect(successDetail?.run.metadata['result']).toEqual({ ok: true })

	const leanExport = beginRunRecord({
		env,
		userId: userId5,
		context: baseContext({ surface: 'export', name: 'lean-ok' }),
	})
	expect(leanExport?.persistence).toBe('on-failure')
	await finishRunRecord({
		env,
		handle: leanExport,
		status: 'success',
		result: { ignored: true },
		logs: ['should not persist'],
	})
	expect(await listRuns(userId5, { surface: 'export' })).toEqual({
		runs: [],
		nextCursor: null,
	})

	const errorHandle = beginRunRecord({
		env,
		userId: userId5,
		context: baseContext({ surface: 'execute', name: 'boom' }),
	})
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		error: new Error('execute failed'),
		logs: ['error log'],
	})
	const execPage = await listRuns(userId5, { surface: 'execute' })
	expect(execPage.runs).toHaveLength(2)
	expect(execPage.runs.find((run) => run.id === errorHandle!.id)).toMatchObject(
		{
			status: 'error',
			errorName: 'Error',
			errorMessage: 'execute failed',
			surface: 'execute',
		},
	)
	expect(execPage.runs.map((run) => run.id)).toContain(successHandle!.id)
})

test('logs round-trip in sequence order and keep only the newest 200', async () => {
	const userId = uniqueUserId('logs-cap')
	const handle = beginRunRecord({
		env,
		userId,
		context: baseContext({ surface: 'workflow' }),
	})
	expect(handle).not.toBeNull()
	const totalLogs = runRecordMaxLogEntriesPerRun + 50
	const logs = Array.from({ length: totalLogs }, (_, index) => `log-${index}`)
	await finishRunRecord({ env, handle, status: 'success', logs })
	const detail = await getRun(userId, handle!.id)
	expect(detail?.logs).toHaveLength(runRecordMaxLogEntriesPerRun)
	expect(detail?.logs[0]).toMatchObject({ sequence: 0, message: 'log-50' })
	expect(detail?.logs.at(-1)).toMatchObject({
		sequence: runRecordMaxLogEntriesPerRun - 1,
		message: `log-${totalLogs - 1}`,
	})
	expect(detail?.run.logCount).toBe(runRecordMaxLogEntriesPerRun)
	expect(
		await sqlOne(
			userId,
			`SELECT log_count FROM runs WHERE id = '${handle!.id}'`,
		),
	).toEqual({ log_count: runRecordMaxLogEntriesPerRun })
})

test('listRunRecords filters by surface/status/jobId/name and paginates with cursors', async () => {
	const userId = uniqueUserId('list-filter')
	const startedAtBase = Date.now() - 60_000
	for (let index = 0; index < 5; index += 1) {
		await finishRunRecord({
			env,
			handle: handleFor(
				userId,
				`run-${index}`,
				{
					surface: index % 2 === 0 ? 'job' : 'export',
					jobId: index < 3 ? 'job-shared' : 'job-other',
					name: index < 2 ? 'shared-name' : `run-${index}`,
				},
				startedAtBase + index * 1000,
			),
			status: index === 1 ? 'error' : 'success',
			error: index === 1 ? new Error('fail') : undefined,
		})
	}

	const cases: Array<[RunRecordFilter, Array<string>]> = [
		[{ surface: 'job' }, ['run-4', 'run-2', 'run-0']],
		[{ status: 'error' }, ['run-1']],
		[{ jobId: 'job-shared' }, ['run-2', 'run-1', 'run-0']],
		[{ name: 'shared-name' }, ['run-1', 'run-0']],
	]
	const listed: typeof cases = []
	for (const [filter] of cases) {
		const page = await listRuns(userId, filter)
		listed.push([filter, page.runs.map((run) => run.id)])
	}
	expect(listed).toEqual(cases)

	const workflowUserId = uniqueUserId('list-workflow-filter')
	await finishOk(workflowUserId, 'run-other-workflow', {
		surface: 'workflow',
		workflowId: 'dynwf-other',
	})
	await finishRunRecord({
		env,
		handle: handleFor(workflowUserId, 'run-workflow', {
			surface: 'workflow',
			workflowId: 'dynwf-check-back',
		}),
		status: 'success',
		result: { answer: 42 },
	})
	const workflowPage = await listRuns(workflowUserId, {
		workflowId: 'dynwf-check-back',
	})
	expect(workflowPage.runs).toEqual([
		expect.objectContaining({
			id: 'run-workflow',
			workflowId: 'dynwf-check-back',
			status: 'success',
			metadata: expect.objectContaining({ result: { answer: 42 } }),
		}),
	])

	const pages: Array<Array<string>> = []
	let cursor: string | null = null
	do {
		const page = await listRunRecords({ env, userId, limit: 2, cursor })
		pages.push(page.runs.map((run) => run.id))
		cursor = page.nextCursor
	} while (cursor)
	expect(pages).toEqual([['run-4', 'run-3'], ['run-2', 'run-1'], ['run-0']])
	expect(cursor).toBeNull()
})

test('summarizeRunRecords returns totals and per-surface error counts', async () => {
	const userId = uniqueUserId('summarize')
	const startedAtBase = Date.now() - 60_000
	const cases: Array<[RunSurface, 'success' | 'error']> = [
		['job', 'success'],
		['job', 'error'],
		['job', 'error'],
		['export', 'success'],
		['export', 'error'],
	]
	for (const [index, [surface, status]] of cases.entries()) {
		await finishRunRecord({
			env,
			handle: handleFor(
				userId,
				crypto.randomUUID(),
				{ surface, name: `s-${index}` },
				startedAtBase + index * 1000,
			),
			status,
			error: status === 'error' ? new Error('x') : undefined,
		})
	}

	const summary = await summarizeRunRecords({
		env,
		userId,
		since: iso(startedAtBase - 1_000),
	})
	expect(summary).toMatchObject({
		total: 5,
		errors: 3,
		ignored: 0,
		resolved: 0,
		running: 0,
	})
	expect(summary.bySurface).toEqual(
		expect.arrayContaining([
			{ surface: 'export', total: 2, errors: 1 },
			{ surface: 'job', total: 3, errors: 2 },
		]),
	)
})

test('later job success soft-resolves prior open errors for only that job', async () => {
	const userId = uniqueUserId('auto-resolve-job')
	const baseMs = Date.now() - 60_000
	const finish = (
		id: string,
		jobId: string,
		offset: number,
		errorMessage?: string,
	) =>
		finishRunRecord({
			env,
			handle: handleFor(
				userId,
				id,
				{ surface: 'job', jobId, name: 'recurring-job' },
				baseMs + offset,
			),
			status: errorMessage ? 'error' : 'success',
			error: errorMessage ? new Error(errorMessage) : undefined,
		})

	await finish('same-job-open', 'job-a', 0, 'first failure')
	await finish('same-job-ignored', 'job-a', 1, 'known noise')
	await finish('other-job-open', 'job-b', 2, 'still broken')
	const ignored = await updateRunErrorTriage({
		env,
		userId,
		runId: 'same-job-ignored',
		errorTriage: 'ignored',
		triageNote: 'user chose to ignore',
	})
	expect(ignored.ok).toBe(true)

	await finish('same-job-success', 'job-a', 3)

	const all = await listRuns(userId, { errorTriage: 'all' }, 10)
	const byId = new Map(all.runs.map((run) => [run.id, run]))
	expect(byId.get('same-job-open')).toMatchObject({
		status: 'error',
		errorMessage: 'first failure',
		errorTriage: 'resolved',
		triageNote: 'auto-resolved: later success of the same job',
		triagedBy: 'system:auto-resolve',
		startedBy: null,
	})
	expect(byId.get('same-job-ignored')).toMatchObject({
		status: 'error',
		errorTriage: 'ignored',
		triageNote: 'user chose to ignore',
	})
	expect(byId.get('other-job-open')).toMatchObject({
		status: 'error',
		errorTriage: null,
	})
	expect(byId.get('same-job-success')).toMatchObject({
		status: 'success',
		errorTriage: null,
	})
	expect(await summarizeRunRecords({ env, userId })).toMatchObject({
		total: 4,
		errors: 1,
		ignored: 1,
		resolved: 1,
	})
})

test('bulk triage honors the public limit of 100 across write paths', async () => {
	for (const limit of [25, 100]) {
		const userId = uniqueUserId(`bulk-triage-${limit}`)
		const jobId = `exact-job-${limit}`
		const rows = finishedRows(
			`bulk-${limit}`,
			limit,
			Date.now(),
			{
				status: 'error',
				jobId,
				errorName: 'Error',
				errorMessage: 'reproducible failure',
			},
			-1,
		)
		const runIds = rows.map((row) => row.id)
		await seedRuns(userId, rows)
		const bulk = (
			input: Omit<
				Parameters<typeof bulkUpdateRunErrorTriage>[0],
				'env' | 'userId' | 'limit'
			>,
		) => bulkUpdateRunErrorTriage({ env, userId, limit, ...input })
		const all = { updatedCount: limit, hasMore: false }

		await expect(
			bulk({
				filter: { jobId },
				errorTriage: 'resolved',
				triageNote: 'production cleanup',
				dryRun: true,
			}),
		).resolves.toMatchObject({
			matchedRunIds: expect.arrayContaining([`bulk-${limit}-0`]),
			updatedCount: 0,
			hasMore: false,
		})
		await expect(
			bulk({
				filter: { jobId },
				errorTriage: 'resolved',
				triageNote: 'production cleanup',
				dryRun: false,
			}),
		).resolves.toMatchObject(all)

		const resolved = await listRuns(
			userId,
			{ jobId, errorTriage: 'resolved' },
			limit,
		)
		expect(resolved.runs).toHaveLength(limit)
		expect(resolved.runs.every((run) => run.errorTriage === 'resolved')).toBe(
			true,
		)

		await expect(
			bulk({ filter: { jobId, errorTriage: 'resolved' }, errorTriage: null }),
		).resolves.toMatchObject(all)
		await expect(
			bulk({ runIds, errorTriage: 'ignored' }),
		).resolves.toMatchObject(all)
		await expect(bulk({ runIds, errorTriage: null })).resolves.toMatchObject(
			all,
		)

		const reopened = await listRuns(
			userId,
			{ jobId, errorTriage: 'open' },
			limit,
		)
		expect(reopened.runs).toHaveLength(limit)
		expect(reopened.runs.every((run) => run.errorTriage === null)).toBe(true)
	}
})

test('bulk triage rolls back earlier chunks when a later chunk fails', async () => {
	const userId = uniqueUserId('bulk-triage-atomic')
	const jobId = 'atomic-job'
	const stub = runLogStub(userId)
	await seedRuns(
		userId,
		finishedRows(
			'atomic',
			100,
			Date.now(),
			{
				status: 'error',
				jobId,
				errorName: 'Error',
				errorMessage: 'atomic failure fixture',
			},
			-1,
		),
	)
	// Resolve chunks contain 94 ids. This sentinel is selected into the
	// second chunk so the first UPDATE has already executed when it aborts.
	await runInDurableObject(stub, async (_instance: RunLog, state) => {
		state.storage.sql.exec(
			`CREATE TRIGGER reject_atomic_sentinel
			BEFORE UPDATE OF error_triage ON runs
			WHEN OLD.id = 'atomic-99'
			BEGIN
				SELECT RAISE(ABORT, 'forced second chunk failure');
			END`,
		)
	})

	// SQL abort inside the DO is the behavior under test. Call the method
	// in-isolate so workerd does not log the expected rejection as an
	// uncaught RPC exception.
	await expect(
		runInDurableObject(stub, async (instance: RunLog) =>
			instance.bulkUpdateRunErrorTriage({
				runIds: null,
				filter: { jobId },
				errorTriage: 'resolved',
				preserveTriageNote: true,
				triageNote: null,
				triagedBy: userId,
				limit: 100,
				dryRun: false,
			}),
		),
	).rejects.toThrow(/forced second chunk failure/)

	expect(await countRuns(userId, 'error_triage IS NOT NULL')).toBe(0)
})

test('cap and stale retention journey', async () => {
	// --- handled duplicate errors are deleted before successes and open errors ---
	{
		const userId = uniqueUserId('retention-priority')
		const baseMs = Date.now() - 3_600_000
		const triagedErrorCount = runRecordMaxRunsPerUser - 20
		const successCount = 20
		const openErrorCount = 10
		const seeded = triagedErrorCount + successCount + openErrorCount
		await seedRuns(userId, [
			...finishedRows('duplicate-error', triagedErrorCount, baseMs, {
				status: 'error',
				errorMessage: 'same recurring failure',
				errorTriage: 'resolved',
			}),
			...finishedRows('success', successCount, baseMs + triagedErrorCount, {
				status: 'success',
			}),
			...finishedRows(
				'open-error',
				openErrorCount,
				baseMs + triagedErrorCount + successCount,
				{ status: 'error', errorMessage: 'still broken' },
			),
		])
		await armRetentionOnNextFinish(userId, seeded)
		await finishOk(
			userId,
			'retention-trigger',
			{ name: 'trigger' },
			baseMs + seeded + 20,
		)
		const summary = await runLogRpc({ env, userId }).summarize({
			since: '1970-01-01T00:00:00.000Z',
		})
		expect(summary.total).toBe(runRecordMaxRunsPerUser)
		expect(summary.errors).toBe(openErrorCount)
		expect(
			await sqlOne(
				userId,
				`SELECT
					SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
					SUM(CASE WHEN status = 'error' AND error_triage IS NOT NULL THEN 1 ELSE 0 END) AS triaged_errors,
					SUM(CASE WHEN status = 'error' AND error_triage IS NULL THEN 1 ELSE 0 END) AS open_errors
				FROM runs`,
			),
		).toEqual({
			successes: successCount + 1,
			triaged_errors:
				runRecordMaxRunsPerUser - successCount - openErrorCount - 1,
			open_errors: openErrorCount,
		})
		expect(await countRuns(userId, `id = 'duplicate-error-0'`)).toBe(0)
	}

	// --- cap eviction never deletes in-flight running rows ---
	{
		const userId = uniqueUserId('cap-protect-running')
		const baseMs = Date.now() - 3_600_000
		// Fewer successes than the eventual excess so the old success→running→error
		// order would delete the in-flight row after successes are exhausted.
		const successCount = 2
		const errorCount = runRecordMaxRunsPerUser
		const seeded = successCount + 1 + errorCount
		await seedRuns(userId, [
			...finishedRows('success', successCount, baseMs, { status: 'success' }),
			{
				id: 'still-running',
				status: 'running',
				startedAt: iso(baseMs + successCount),
			},
			...finishedRows('error', errorCount, baseMs + successCount + 1, {
				status: 'error',
			}),
		])
		await armRetentionOnNextFinish(userId, seeded)
		await finishOk(
			userId,
			'cap-running-trigger',
			{ name: 'cap-running-trigger' },
			baseMs + seeded + 10,
		)
		expect((await getRun(userId, 'still-running'))?.run.status).toBe('running')
		// Excess was 4: 3 successes (2 seeded + trigger) then 1 oldest error.
		// The in-flight row is skipped entirely.
		expect(
			await sqlOne(
				userId,
				`SELECT
					SUM(status = 'success') AS successes,
					SUM(status = 'error') AS errors,
					SUM(status = 'running') AS running,
					SUM(id = 'success-0') AS success0,
					SUM(id = 'error-0') AS error0
				FROM runs`,
			),
		).toEqual({
			successes: 0,
			errors: errorCount - 1,
			running: 1,
			success0: 0,
			error0: 0,
		})
	}

	// --- stale running rows reconciled to interrupted errors; fresh running preserved ---
	{
		const userId = uniqueUserId('stale-running')
		await seedRuns(userId, [
			{
				id: 'stale-running',
				status: 'running',
				startedAt: iso(Date.now() - runRecordStaleRunningTtlMsJob - 60_000),
			},
			{ id: 'fresh-running', status: 'running', startedAt: iso(Date.now()) },
		])
		await armRetentionOnNextFinish(userId, 2)
		await finishOk(userId, 'stale-trigger', { name: 'stale-trigger' })
		const stale = await getRun(userId, 'stale-running')
		expect(stale?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			errorMessage:
				'The platform interrupted this run before completion; outcome unknown.',
			errorTriage: null,
		})
		expect(stale?.run.finishedAt).toBeTruthy()
		expect((await getRun(userId, 'fresh-running'))?.run).toMatchObject({
			status: 'running',
			finishedAt: null,
		})
	}

	// --- execute-surface stale rows heal on read within minutes, not 24h ---
	{
		const userId = uniqueUserId('stale-execute-heal')
		await seedRuns(userId, [
			{
				id: 'stale-execute',
				status: 'running',
				startedAt: iso(
					Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000,
				),
				surface: 'execute',
			},
		])
		expect((await getRun(userId, 'stale-execute'))?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			surface: 'execute',
		})
	}

	// --- a webhook run inside the 5-minute background budget is not stale ---
	{
		const userId = uniqueUserId('stale-webhook-heal')
		await seedRuns(userId, [
			{
				id: 'live-webhook',
				status: 'running',
				startedAt: iso(Date.now() - backgroundExecutorTimeoutMs),
				surface: 'webhook',
			},
			{
				id: 'stale-webhook',
				status: 'running',
				startedAt: iso(
					Date.now() - runRecordStaleRunningTtlMsBackground - 1_000,
				),
				surface: 'webhook',
			},
		])
		expect((await getRun(userId, 'live-webhook'))?.run).toMatchObject({
			status: 'running',
		})
		expect((await getRun(userId, 'stale-webhook'))?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			surface: 'webhook',
		})
	}

	// --- queued deliveries stay auto-ignored; scheduled ticks stay visible and releasable ---
	{
		const userId = uniqueUserId('idempotent-platform-interrupt')
		const staleJobStartedAt = iso(
			Date.now() - runRecordStaleRunningTtlMsScheduledJob - 1_000,
		)
		const staleShortStartedAt = iso(
			Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000,
		)
		const scheduledKey = 'scheduled-job:job-1:2026-08-21T00:00:00.000Z'
		await seedRuns(userId, [
			{
				id: 'stale-scheduled-job',
				status: 'running',
				startedAt: staleJobStartedAt,
				surface: 'job',
				jobId: 'job-1',
				idempotencyKey: scheduledKey,
			},
			{
				id: 'stale-subscription-delivery',
				status: 'running',
				startedAt: staleShortStartedAt,
				surface: 'subscription',
				idempotencyKey: 'delivery-123',
			},
			{
				id: 'stale-keyed-export',
				status: 'running',
				startedAt: staleShortStartedAt,
				surface: 'export',
				idempotencyKey: 'youtube:websub:video-1:2026-08-25T13:41:52.301Z',
			},
		])
		const autoIgnored = {
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			errorTriage: 'ignored',
			triagedBy: 'system:platform-interrupt',
			startedBy: null,
		}

		const page = await listRuns(userId, { errorTriage: 'all' })
		expect(page.runs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'stale-scheduled-job',
					status: 'error',
					errorName: runRecordPlatformInterruptedErrorName,
					errorTriage: null,
					idempotencyKey: null,
				}),
				expect.objectContaining({
					id: 'stale-subscription-delivery',
					...autoIgnored,
				}),
				expect.objectContaining({
					id: 'stale-keyed-export',
					...autoIgnored,
				}),
			]),
		)
		expect(
			await summarizeRunRecords({ env, userId, since: iso(0) }),
		).toMatchObject({ errors: 1, ignored: 2, running: 0 })
		expect(
			(await listRuns(userId, { errorTriage: 'ignored' })).runs,
		).toHaveLength(2)

		// Cleared key lets the scheduler claim the occurrence again.
		const reclaimed = await claimRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'example-job',
				jobId: 'job-1',
				idempotencyKey: scheduledKey,
			},
		})
		expect(reclaimed).toMatchObject({ claimed: true })
		if (!reclaimed || !reclaimed.claimed) {
			throw new Error('expected scheduled-job key reclaim after interrupt')
		}
		await finishRunRecord({
			env,
			handle: reclaimed.handle,
			status: 'success',
			result: { recovered: true },
		})
		expect((await getRun(userId, reclaimed.handle.id))?.run).toMatchObject({
			status: 'success',
			idempotencyKey: scheduledKey,
		})
		for (const runId of ['stale-subscription-delivery', 'stale-keyed-export']) {
			expect((await getRun(userId, runId))?.run).toMatchObject(autoIgnored)
		}
	}

	// --- RunLog alarm arms at the scheduled-tick lease, not the job-surface TTL ---
	{
		const userId = uniqueUserId('scheduled-job-alarm-lease')
		const startedAtMs = Date.now() - 60_000
		await seedRuns(userId, [
			{
				id: 'live-scheduled-tick',
				status: 'running',
				startedAt: iso(startedAtMs),
				surface: 'job',
				jobId: 'job-alarm',
				idempotencyKey: 'scheduled-job:job-alarm:2026-08-21T10:00:00.000Z',
			},
		])
		await armRetentionOnNextFinish(userId, 1)
		const beforeArm = Date.now()
		await finishOk(userId, 'alarm-arm-trigger', { name: 'alarm-arm-trigger' })
		const alarmAt = await getAlarm(userId)
		expect(alarmAt).toBeTypeOf('number')
		const dueAt = startedAtMs + runRecordStaleRunningTtlMsScheduledJob
		expect(alarmAt).toBeGreaterThanOrEqual(
			Math.min(dueAt, beforeArm + 1_000) - 100,
		)
		expect(alarmAt).toBeLessThan(
			beforeArm + runRecordStaleRunningTtlMsScheduledJob + 5_000,
		)
		expect(alarmAt).toBeLessThan(beforeArm + runRecordStaleRunningTtlMsJob / 2)
	}

	// --- mid-age non-scheduled job rows must not starve scheduled-tick reconcile ---
	{
		const userId = uniqueUserId('scheduled-job-reconcile-page')
		const midAgeStartedAt = iso(
			Date.now() - runRecordStaleRunningTtlMsScheduledJob - 120_000,
		)
		const scheduledStartedAt = iso(
			Date.now() - runRecordStaleRunningTtlMsScheduledJob - 60_000,
		)
		// Matches maxStaleRunningReconcilesPerPass in run-log-do.ts.
		const midAgeJobCount = 100
		await seedRuns(userId, [
			...Array.from({ length: midAgeJobCount }, (_, index) => ({
				id: `mid-age-job-${index}`,
				status: 'running' as const,
				startedAt: midAgeStartedAt,
				surface: 'job' as const,
				jobId: `mid-age-${index}`,
				idempotencyKey: `manual-job:${index}`,
			})),
			{
				id: 'stale-scheduled-behind-page',
				status: 'running',
				startedAt: scheduledStartedAt,
				surface: 'job',
				jobId: 'job-behind',
				idempotencyKey: 'scheduled-job:job-behind:2026-08-21T10:00:00.000Z',
			},
		])
		await armRetentionOnNextFinish(userId, midAgeJobCount + 1)
		await finishOk(userId, 'reconcile-page-trigger', {
			name: 'reconcile-page-trigger',
		})
		expect(
			(await getRun(userId, 'stale-scheduled-behind-page'))?.run,
		).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			errorTriage: null,
			idempotencyKey: null,
		})
		expect((await getRun(userId, 'mid-age-job-0'))?.run).toMatchObject({
			status: 'running',
		})
	}

	// --- a real late finish replaces reconciled platform interrupt ---
	{
		const userId = uniqueUserId('late-finish-after-interrupted')
		const staleStartedAtMs =
			Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000
		const handle = handleFor(
			userId,
			'late-finish-after-interrupted',
			{ surface: 'export', name: './slow-export' },
			staleStartedAtMs,
		)
		await seedRuns(userId, [
			{
				id: handle.id,
				status: 'running',
				startedAt: handle.startedAt,
				surface: 'export',
			},
		])
		expect((await getRun(userId, handle.id))?.run.errorName).toBe(
			runRecordPlatformInterruptedErrorName,
		)

		await finishRunRecord({
			env,
			handle,
			status: 'success',
			result: { completed: true },
		})
		const completed = await getRun(userId, handle.id)
		expect(completed?.run).toMatchObject({
			status: 'success',
			errorName: null,
			metadata: { result: { completed: true } },
		})
	}

	// --- late finish must not restore a released scheduled-tick key ---
	{
		const userId = uniqueUserId('scheduled-late-finish-fenced')
		const scheduledKey = 'scheduled-job:job-late:2026-08-21T10:00:00.000Z'
		const staleStartedAtMs =
			Date.now() - runRecordStaleRunningTtlMsScheduledJob - 1_000
		const handle = handleFor(
			userId,
			'scheduled-late-finish',
			{
				surface: 'job',
				name: 'scheduled-late-finish',
				jobId: 'job-late',
				idempotencyKey: scheduledKey,
			},
			staleStartedAtMs,
		)
		await seedRuns(userId, [
			{
				id: handle.id,
				status: 'running',
				startedAt: handle.startedAt,
				surface: 'job',
				jobId: 'job-late',
				idempotencyKey: scheduledKey,
			},
		])
		expect((await getRun(userId, handle.id))?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			idempotencyKey: null,
		})

		expect(
			await finishRunRecord({
				env,
				handle,
				status: 'success',
				result: { completed: true },
			}),
		).toBe(false)
		expect((await getRun(userId, handle.id))?.run).toMatchObject({
			status: 'error',
			errorName: runRecordPlatformInterruptedErrorName,
			idempotencyKey: null,
		})

		const reclaimed = await claimRunRecord({
			env,
			userId,
			context: {
				surface: 'job',
				name: 'scheduled-late-finish',
				jobId: 'job-late',
				idempotencyKey: scheduledKey,
			},
		})
		expect(reclaimed).toMatchObject({ claimed: true })
	}

	// --- stale rows become cap-evictable after reconcile ---
	{
		const userId = uniqueUserId('stale-cap-evict')
		const baseMs = Date.now() - 3_600_000
		const staleStartedAtMs = Date.now() - runRecordStaleRunningTtlMsJob - 60_000
		const successCount = 2
		const errorCount = runRecordMaxRunsPerUser - 2
		const staleCount = 5
		const seeded = successCount + staleCount + errorCount
		await seedRuns(userId, [
			...finishedRows('success', successCount, baseMs, { status: 'success' }),
			...finishedRows('stale', staleCount, staleStartedAtMs, {
				status: 'running',
				finishedAt: null,
			}),
			...finishedRows('error', errorCount, baseMs + 10_000, {
				status: 'error',
			}),
		])
		await armRetentionOnNextFinish(userId, seeded)
		await finishOk(
			userId,
			'stale-cap-trigger',
			{ name: 'stale-cap-trigger' },
			baseMs + seeded + 10,
		)
		// Reconcile demotes stale running → Interrupted errors (oldest started_at),
		// then cap eviction drains successes and those demoted errors before newer
		// seeded errors.
		expect(await getRun(userId, 'stale-0')).toBeNull()
		expect(await countRuns(userId, `status = 'running'`)).toBe(0)
	}

	// --- amortized retention enforces the age cap ---
	{
		const userId = uniqueUserId('age-retention')
		await seedRuns(userId, [
			...finishedRows(
				'old-success',
				1,
				Date.now() - (runRecordRetentionDays + 2) * dayMs,
				{ status: 'success' },
			),
			...finishedRows('recent-success', 1, Date.now() - 60_000, {
				status: 'success',
			}),
		])
		await armRetentionOnNextFinish(userId, 2)
		await finishOk(userId, 'age-trigger', { name: 'age-trigger' })
		const ids = (await listRuns(userId)).runs.map((run) => run.id)
		expect(ids).toContain('recent-success-0')
		expect(ids).toContain('age-trigger')
		expect(ids).not.toContain('old-success-0')
	}
})

test('alarm lifecycle: fresh arm, self-termination when idle, re-arm after idle, and age-prune', async () => {
	const userId = uniqueUserId('alarm-lifecycle')
	const stub = runLogStub(userId)
	const startedAtMs = Date.now()
	const expiredStartedAt = iso(
		Date.now() - (runRecordRetentionDays + 3) * dayMs,
	)
	const expireAndFireAlarm = (runId: string) =>
		runInDurableObject(stub, async (instance: RunLog, state) => {
			state.storage.sql.exec(
				`UPDATE runs SET started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
				expiredStartedAt,
				expiredStartedAt,
				expiredStartedAt,
				runId,
			)
			seedRunLogMeta(instance, { finishesSinceRetention: 0 })
			await state.storage.deleteAlarm()
			await instance.alarm()
		})

	// Fresh finish arms a far-future retention alarm at the row's age deadline.
	await finishOk(userId, 'first-run', { name: 'fresh' }, startedAtMs)
	const initialAlarm = await getAlarm(userId)
	expect(initialAlarm).toBeTypeOf('number')
	// One-shot at the row's age deadline — not an immediate/hourly wake.
	expect(initialAlarm).toBeGreaterThan(
		startedAtMs + runRecordRetentionDays * dayMs - 5_000,
	)

	// Age the row past the retention cutoff and fire the alarm directly.
	// Runs prune first; durable day counts outlive them, so the alarm stays
	// armed for the day-count horizon instead of self-terminating.
	await expireAndFireAlarm('first-run')
	expect(await countRuns(userId)).toBe(0)
	expect(await getAlarm(userId)).toBeTypeOf('number')

	const expireDayCountsAndFire = () =>
		runInDurableObject(stub, async (instance: RunLog, state) => {
			const oldDay = iso(
				Date.now() - (runRecordRetentionDays + 3) * dayMs,
			).slice(0, 10)
			state.storage.sql.exec(`UPDATE run_day_counts SET day = ?`, oldDay)
			seedRunLogMeta(instance, { finishesSinceRetention: 0 })
			await state.storage.deleteAlarm()
			await instance.alarm()
		})
	await expireDayCountsAndFire()
	expect(await getAlarm(userId)).toBeNull()

	// Write after idle re-arms the alarm for the new row.
	const runId = 'post-idle-run'
	await finishOk(userId, runId, { name: 'post-idle' })
	expect(await getAlarm(userId)).toBeTypeOf('number')

	// Age the post-idle run past the cutoff without bumping the amortized finish
	// counter; alarm fires, prunes the run, keeps day-count work scheduled.
	await expireAndFireAlarm(runId)
	expect(await getRun(userId, runId)).toBeNull()
	expect(await getAlarm(userId)).toBeTypeOf('number')
	await expireDayCountsAndFire()
	expect(await getAlarm(userId)).toBeNull()
})

test('empty over-cap retention backs off; summarize memos; list does not reconcile', async () => {
	// Over-cap with only in-flight rows: an empty pass must not re-arm at 1s.
	{
		const userId = uniqueUserId('over-cap-backoff')
		await seedRuns(userId, [
			{ id: 'only-running', status: 'running', startedAt: iso(Date.now()) },
		])
		await runInDurableObject(
			runLogStub(userId),
			async (instance: RunLog, state) => {
				seedRunLogMeta(instance, {
					runCount: runRecordMaxRunsPerUser + 1,
					finishesSinceRetention: 0,
				})
				const beforeFirst = Date.now()
				await instance.alarm()
				const firstAlarm = await state.storage.getAlarm()
				expect(firstAlarm).toBeTypeOf('number')
				expect(firstAlarm).toBeGreaterThanOrEqual(
					beforeFirst + runRecordRetentionEmptyBackoffMinMs - 100,
				)
				expect(firstAlarm).toBeLessThan(
					beforeFirst + runRecordRetentionEmptyBackoffMinMs + 2_000,
				)
				expect(
					state.storage.sql
						.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs`)
						.one().n,
				).toBe(1)

				const beforeSecond = Date.now()
				await instance.alarm()
				expect(await state.storage.getAlarm()).toBeGreaterThanOrEqual(
					beforeSecond + runRecordRetentionEmptyBackoffMinMs * 2 - 100,
				)
			},
		)
		await finishOk(userId, 'now-evictable', { name: 'now-evictable' })
		const pulledIn = await getAlarm(userId)
		expect(pulledIn).toBeTypeOf('number')
		expect(pulledIn).toBeLessThan(Date.now() + 5_000)
	}

	// Same-since summarize reuses the isolate memo; list heals page rows only.
	{
		const userId = uniqueUserId('hot-path-reads')
		const startedAtBase = Date.now() - 60_000
		for (const index of [0, 1, 2]) {
			await finishOk(
				userId,
				`hot-${index}`,
				{ name: `hot-${index}` },
				startedAtBase + index * 1000,
			)
		}
		const since = iso(startedAtBase - 1_000)
		const summarizeOp = async () =>
			(await getSqlBillingStats({ env, userId })).ops.find(
				(op) => op.op === 'summarize',
			)
		expect((await summarizeRunRecords({ env, userId, since })).total).toBe(3)
		const summarizeAfterFirst = await summarizeOp()
		expect(summarizeAfterFirst?.calls).toBe(1)
		for (let index = 0; index < 4; index += 1) {
			expect((await summarizeRunRecords({ env, userId, since })).total).toBe(3)
		}
		const summarizeAfterMemo = await summarizeOp()
		expect(summarizeAfterMemo?.calls).toBe(1)
		expect(summarizeAfterMemo?.rowsRead).toBe(summarizeAfterFirst?.rowsRead)

		for (let index = 0; index < 5; index += 1) {
			await listRuns(userId)
		}
		const afterLists = await getSqlBillingStats({ env, userId })
		expect(afterLists.ops.some((op) => op.op === 'reconcileStaleRunning')).toBe(
			false,
		)

		await finishOk(userId, 'hot-3', { name: 'hot-3' }, startedAtBase + 3_000)
		expect((await summarizeRunRecords({ env, userId, since })).total).toBe(4)
		expect((await summarizeOp())?.calls).toBe(2)
	}

	{
		const userId = uniqueUserId('list-page-heal')
		await seedRuns(userId, [
			{
				id: 'stale-on-page',
				status: 'running',
				startedAt: iso(
					Date.now() - runRecordStaleRunningTtlMsShortLived - 1_000,
				),
				surface: 'execute',
			},
		])
		expect((await listRuns(userId, { status: 'running' })).runs).toHaveLength(0)
		expect((await listRuns(userId)).runs).toEqual([
			expect.objectContaining({
				id: 'stale-on-page',
				status: 'error',
				errorName: runRecordPlatformInterruptedErrorName,
			}),
		])
		const stats = await getSqlBillingStats({ env, userId })
		expect(stats.ops.some((op) => op.op === 'reconcileStaleRunning')).toBe(
			false,
		)
		expect(
			stats.ops.some((op) => op.op === 'healStaleRunning' && op.calls >= 1),
		).toBe(true)
	}

	{
		const userId = uniqueUserId('package-finish-memo')
		const claimed = await claimPackageInvocationRecord({
			env,
			userId,
			context: {
				surface: 'export',
				packageId: 'pkg-memo',
				name: 'handler',
				idempotencyKey: 'evt-memo',
			},
			invocation: {
				id: crypto.randomUUID(),
				tokenId: 'token-memo',
				packageId: 'pkg-memo',
				packageKodyId: 'kody-memo',
				exportName: 'handler',
				idempotencyKey: 'evt-memo',
				requestHash: 'hash-memo',
				source: null,
				topic: null,
			},
			staleBefore: iso(0),
		})
		if (claimed.outcome !== 'claimed') throw new Error('expected claim')
		const since = iso(0)
		expect((await summarizeRunRecords({ env, userId, since })).running).toBe(1)
		const finished = await finishPackageInvocationRecord({
			env,
			userId,
			handle: claimed.handle,
			invocationId: claimed.invocationId,
			claimUpdatedAt: claimed.claimUpdatedAt,
			ledgerStatus: 'completed',
			responseJson: JSON.stringify({ ok: true }),
			status: 'success',
		})
		expect(finished.ledgerUpdated).toBe(true)
		expect(await summarizeRunRecords({ env, userId, since })).toMatchObject({
			total: 1,
			running: 0,
		})
	}
})

test('run recording degrades to a warning instead of failing the observed run', async () => {
	silenceIncidentalRuntimeWarnings()
	const userId = uniqueUserId('never-throws')
	expect(
		beginRunRecord({
			env,
			userId,
			context: baseContext({ surface: 'not-a-surface' as RunSurface }),
		}),
	).toBeNull()

	// Finish still lands even when begin was refused; activation now lives in
	// the RunLog DO (not D1), so a successful finish does not emit an
	// activation warning here.
	await finishOk(userId, crypto.randomUUID(), {
		surface: 'subscription',
		name: 'email.message.received',
		packageId: 'package-1',
	})

	expect(consoleWarn.mock.calls.map(([message]) => message)).toEqual([
		'run-record-begin-failed',
	])
	expect((await listRuns(userId)).runs).toEqual([
		expect.objectContaining({ status: 'success' }),
	])
})

test('run_log_meta counters reuse the in-isolate cache across repeated reads', async () => {
	const userId = uniqueUserId('meta-cache')
	const stub = runLogStub(userId)
	const metaValues = () =>
		sqlOne<{ runCount: number; finishes: number }>(
			userId,
			`SELECT
				MAX(CASE WHEN key = 'run_count' THEN value END) AS runCount,
				MAX(CASE WHEN key = 'finishes_since_retention' THEN value END) AS finishes
			FROM run_log_meta`,
		)
	const startRunning = async (name: string) => {
		const pending: Array<Promise<unknown>> = []
		beginRunRecord({
			env,
			userId,
			context: baseContext({ name }),
			waitUntil: (promise) => {
				pending.push(promise)
			},
		})
		await drainWaitUntil(pending)
	}

	// Two finishes → run_count memo should be 2 after the second write path.
	for (const label of ['a', 'b'] as const) {
		await finishOk(userId, crypto.randomUUID(), { name: `meta-${label}` })
	}
	expect((await metaValues()).runCount).toBe(2)

	// Corrupt storage under the memo. The next adjust must use the cached
	// 2 (+1 → 3), not the corrupted SQL value.
	await runInDurableObject(stub, async (_instance: RunLog, state) => {
		state.storage.sql.exec(
			`UPDATE run_log_meta SET value = 999999 WHERE key = 'run_count'`,
		)
	})
	await startRunning('meta-c')
	expect((await metaValues()).runCount).toBe(3)

	await runInDurableObject(stub, async (instance: RunLog) => {
		// Seeds go through setMeta so the memo and SQL stay aligned.
		seedRunLogMeta(instance, { runCount: 10, finishesSinceRetention: 4 })
		// Rolled-back setMeta must not leave the memo ahead of SQL.
		const metaTx = instance as unknown as {
			transactionSyncWithMetaCache: <T>(fn: () => T) => T
			setMeta: (key: string, value: number) => void
		}
		expect(() =>
			metaTx.transactionSyncWithMetaCache(() => {
				metaTx.setMeta('run_count', 99)
				throw new Error('force-rollback')
			}),
		).toThrow('force-rollback')
	})
	expect(await metaValues()).toEqual({ runCount: 10, finishes: 4 })

	await startRunning('meta-rollback')
	expect((await metaValues()).runCount).toBe(11)
})

test(
	'logs from a real failing sandbox execution land in RunLog via getRunRecord',
	{ timeout: 60_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const userId = uniqueUserId('sandbox-fail-logs')
		const callerContext = createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://kody.dev',
			user: {
				userId: personIdFromStored(String(userId)),
				email: 'sandbox-fail-logs@example.com',
				displayName: 'Sandbox Fail Logs',
			},
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl: 'https://kody.dev',
			userId,
			sourceFiles: {
				'entry.ts': [
					'export default async function main() {',
					"\tconsole.log('alpha')",
					"\tconsole.warn('heads up')",
					"\tconsole.error('captured error')",
					"\tthrow new Error('sandbox boom')",
					'}',
				].join('\n'),
			},
			entryPoint: 'entry.ts',
		})
		const result = await runBundledModuleWithRegistry(
			env,
			callerContext,
			bundle,
			undefined,
			{
				skipCapabilityRegistry: true,
				runRecord: { surface: 'execute', name: 'failing-console-logs' },
			},
		)
		expect(result.error).toBe('sandbox boom')
		expect(result.logs).toEqual([
			'alpha',
			'[warn] heads up',
			'[error] captured error',
		])

		const page = await listRuns(userId, {
			surface: 'execute',
			name: 'failing-console-logs',
		})
		expect(page.runs).toEqual([
			expect.objectContaining({
				status: 'error',
				errorMessage: 'sandbox boom',
			}),
		])

		const detail = await getRun(userId, page.runs[0]!.id)
		// The sandbox flattens console output to strings with a level marker;
		// persistence recovers the structured level so readers can filter and
		// colour by it rather than pattern-matching message text.
		expect(detail?.logs.map((entry) => [entry.level, entry.message])).toEqual([
			['log', 'alpha'],
			['warn', 'heads up'],
			['error', 'captured error'],
		])
	},
)

test('keyed execute claims eagerly, retains bounded result, and replays without a second claim', async () => {
	const userId = uniqueUserId('keyed-execute')
	const key = `execute-key-${crypto.randomUUID()}`
	const claimExecute = (
		context: Omit<RunRecordContext, 'surface' | 'idempotencyKey'> = {},
	) =>
		claimRunRecord({
			env,
			userId,
			context: { surface: 'execute', idempotencyKey: key, ...context },
		})
	const first = await claimExecute({
		name: null,
		metadata: { conversationId: 'conv-keyed' },
	})
	if (!first || !first.claimed) throw new Error('expected claim')
	expect(first.handle.persistence).toBe('eager')

	expect(await claimExecute()).toEqual({
		claimed: false,
		run: expect.objectContaining({
			id: first.handle.id,
			status: 'running',
			idempotencyKey: key,
		}),
	})

	const oversized = { blob: 'x'.repeat(runRecordMaxResultSnapshotBytes + 512) }
	await finishRunRecord({
		env,
		handle: first.handle,
		status: 'success',
		result: oversized,
		logs: ['done'],
	})

	const byKey = await getRunRecordByIdempotencyKey({
		env,
		userId,
		idempotencyKey: key,
		surface: 'execute',
	})
	expect(byKey).toMatchObject({ id: first.handle.id, status: 'success' })
	expect(byKey?.metadata['result']).toEqual(
		expect.objectContaining({
			__truncated__: true,
			preview: expect.stringContaining('... [truncated]'),
		}),
	)

	expect(await claimExecute()).toEqual({
		claimed: false,
		run: expect.objectContaining({ id: first.handle.id, status: 'success' }),
	})

	// Key-less execute success is retained the same way, without a replay key.
	const keyless = beginRunRecord({
		env,
		userId,
		context: { surface: 'execute', name: 'keyless-ok' },
	})
	expect(keyless?.persistence).toBe('eager')
	await finishRunRecord({
		env,
		handle: keyless,
		status: 'success',
		result: { kept: true },
	})
	const page = await listRuns(userId, { surface: 'execute' })
	expect(page.runs.map((run) => run.id)).toEqual([keyless!.id, first.handle.id])
	const keylessDetail = await getRun(userId, keyless!.id)
	expect(keylessDetail?.run).toMatchObject({
		status: 'success',
		idempotencyKey: null,
	})
	expect(keylessDetail?.run.metadata['result']).toEqual({ kept: true })
})

test('idempotency lookup is surface-scoped and abandon releases running claims', async () => {
	const userId = uniqueUserId('surface-key')
	const sharedKey = `shared-key-${crypto.randomUUID()}`
	const lookup = (surface: RunSurface) =>
		getRunRecordByIdempotencyKey({
			env,
			userId,
			idempotencyKey: sharedKey,
			surface,
		})
	await recordRunRecord({
		env,
		userId,
		context: { surface: 'workflow', name: 'wf', idempotencyKey: sharedKey },
		status: 'success',
		result: { from: 'workflow' },
	})
	const executeClaim = await claimRunRecord({
		env,
		userId,
		context: { surface: 'execute', idempotencyKey: sharedKey },
	})
	if (!executeClaim || !executeClaim.claimed) throw new Error('expected claim')

	expect(await lookup('execute')).toMatchObject({
		id: executeClaim.handle.id,
		surface: 'execute',
	})

	await abandonRunRecord({ env, handle: executeClaim.handle })
	expect(await lookup('execute')).toBeNull()
	expect((await lookup('workflow'))?.metadata['result']).toEqual({
		from: 'workflow',
	})
})

test('dashboard aggregates complete owner history and excludes exports, child runs, and out-of-window runs', async () => {
	const userId = uniqueUserId('dashboard')
	const otherUser = uniqueUserId('dashboard-other')
	const now = new Date()
	const start = new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z')
	start.setUTCDate(start.getUTCDate() - 6)
	const since = start.getTime()
	for (let i = 0; i < 31; i++) {
		await finishRunRecord({
			env,
			handle: handleFor(
				userId,
				crypto.randomUUID(),
				{ surface: 'execute' },
				since + 1000,
			),
			status: i === 0 ? 'error' : 'success',
		})
	}
	for (const [owner, context, time] of [
		[userId, { surface: 'export' }, since + 1000],
		[userId, { surface: 'execute', parentRunId: 'parent' }, since + 1000],
		[otherUser, { surface: 'execute' }, since + 1000],
		[userId, { surface: 'execute' }, since - 1],
	] as const) {
		await finishRunRecord({
			env,
			handle: handleFor(owner, crypto.randomUUID(), context, time),
			status: 'error',
		})
	}
	const charts = await loadWorkspaceRunCharts({ env, userId, now })
	expect(charts.days).toHaveLength(7)
	expect(charts.days[0]).toMatchObject({ success: 30, error: 1, running: 0 })
	expect(
		charts.days
			.slice(1)
			.every((day) => day.success + day.error + day.running === 0),
	).toBe(true)
	expect(charts.sources).toEqual([{ surface: 'execute', count: 31 }])
	// Fresh DOs have no warm no-backfill floor; out-of-window days stay in the
	// table but do not set countsSince.
	expect(charts.countsSince).toBeNull()
})

test('dashboard day counts survive the 2000-run cap across several UTC days', async () => {
	const userId = uniqueUserId('dashboard-cap')
	const now = new Date('2026-10-22T18:00:00.000Z')
	const windowStart = new Date('2026-10-16T00:00:00.000Z')
	const dayCount = 7
	const perDay = Math.floor(runRecordMaxRunsPerUser / dayCount) + 1
	const totalCounted = perDay * dayCount
	expect(totalCounted).toBeGreaterThan(runRecordMaxRunsPerUser)

	await runInDurableObject(runLogStub(userId), async (instance: RunLog) => {
		expect(instance).toBeInstanceOf(RunLog)
		for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
			const dayStart = windowStart.getTime() + dayIndex * dayMs + 60 * 60 * 1000
			for (let i = 0; i < perDay; i++) {
				const id = `cap-${dayIndex}-${i}`
				const startedAt = iso(dayStart + i * 1000)
				const run = {
					id,
					surface: 'execute' as const,
					status: 'running' as const,
					name: 'cap-test',
					packageId: null,
					kodyId: null,
					sourceId: null,
					publishedCommit: null,
					storageId: null,
					jobId: null,
					workflowId: null,
					invocationId: null,
					sessionId: null,
					idempotencyKey: null,
					parentRunId: null,
					startedAt,
					finishedAt: null,
					durationMs: null,
					errorName: null,
					errorMessage: null,
					startedBy: null,
					metadataJson: '{}',
					createdAt: startedAt,
					updatedAt: startedAt,
				}
				await instance.startRun({ run })
				await instance.finishRun({
					run: {
						...run,
						status: i % 50 === 0 ? 'error' : 'success',
						finishedAt: startedAt,
						durationMs: 1,
						updatedAt: startedAt,
					},
					logs: [],
				})
			}
		}
		const proto = Object.getPrototypeOf(instance) as {
			enforceRetention: () => { runDeletes: number }
		}
		for (let pass = 0; pass < 40; pass++) {
			const { runDeletes } = proto.enforceRetention.call(instance)
			if (runDeletes === 0) break
		}
	})

	expect(await countRuns(userId)).toBe(runRecordMaxRunsPerUser)

	const charts = await loadWorkspaceRunCharts({ env, userId, now })
	expect(charts.days).toHaveLength(7)
	const chartTotal = charts.days.reduce(
		(sum, day) => sum + day.success + day.error + day.running,
		0,
	)
	expect(chartTotal).toBe(totalCounted)
	for (const day of charts.days) {
		expect(day.success + day.error).toBe(perDay)
		expect(day.running).toBe(0)
		expect(day.error).toBe(Math.ceil(perDay / 50))
		expect(day.success).toBe(perDay - Math.ceil(perDay / 50))
	}
	expect(charts.sources).toEqual([{ surface: 'execute', count: totalCounted }])
	// Cap survival does not imply a warm migration floor.
	expect(charts.countsSince).toBeNull()
})

test('started_by persists on begin/finish and filters runList', async () => {
	const userId = uniqueUserId('started-by')
	const alice = personIdFromStored('person-alice')
	const bob = personIdFromStored('person-bob')
	const pending: Array<Promise<unknown>> = []
	const aliceHandle = beginRunRecord({
		env,
		userId,
		waitUntil: (promise) => {
			pending.push(promise)
		},
		context: baseContext({
			surface: 'execute',
			name: 'alice-run',
			startedBy: {
				userId: alice,
				username: 'alice',
				client: 'mcp',
				label: 'work',
			},
		}),
	})
	const bobHandle = beginRunRecord({
		env,
		userId,
		waitUntil: (promise) => {
			pending.push(promise)
		},
		context: baseContext({
			surface: 'execute',
			name: 'bob-run',
			startedBy: {
				userId: bob,
				username: 'bob',
				client: 'cli',
				label: null,
			},
		}),
	})
	const legacyHandle = beginRunRecord({
		env,
		userId,
		waitUntil: (promise) => {
			pending.push(promise)
		},
		context: baseContext({
			surface: 'execute',
			name: 'legacy-run',
		}),
	})
	expect(aliceHandle).not.toBeNull()
	expect(bobHandle).not.toBeNull()
	expect(legacyHandle).not.toBeNull()
	await drainWaitUntil(pending)
	await finishRunRecord({ env, handle: aliceHandle, status: 'success' })
	await finishRunRecord({ env, handle: bobHandle, status: 'error' })
	await finishRunRecord({ env, handle: legacyHandle, status: 'success' })

	const aliceDetail = await getRun(userId, aliceHandle!.id)
	expect(aliceDetail?.run.startedBy).toEqual({
		userId: alice,
		username: 'alice',
		client: 'mcp',
		label: 'work',
	})
	const legacyDetail = await getRun(userId, legacyHandle!.id)
	expect(legacyDetail?.run.startedBy).toBeNull()

	const filtered = await listRunRecords({
		env,
		userId,
		filter: { startedByUserId: alice, errorTriage: 'all' },
	})
	expect(filtered.runs.map((run) => run.name)).toEqual(['alice-run'])
	expect(filtered.runs[0]?.startedBy?.username).toBe('alice')
})
