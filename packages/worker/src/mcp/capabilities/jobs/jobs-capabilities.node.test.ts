import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	getJobInspection: vi.fn(),
	inspectJobsForUser: vi.fn(),
	listRunRecords: vi.fn(),
	listWorkflowRunsForUser: vi.fn(),
	runJobNowViaManager: vi.fn(),
	updateJob: vi.fn(),
	resolveCronJobEnablementHint: vi.fn(),
	authorize: vi.fn(async (..._args: Array<unknown>) => undefined),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/authorization/authorize.ts')>()
	return {
		...actual,
		authorize: mockModule.authorize,
	}
})

vi.mock('#worker/jobs/service.ts', () => ({
	updateJob: (...args: Array<unknown>) => mockModule.updateJob(...args),
}))

vi.mock('#worker/jobs/inspect.ts', () => ({
	getJobInspection: (...args: Array<unknown>) =>
		mockModule.getJobInspection(...args),
	inspectJobsForUser: (...args: Array<unknown>) =>
		mockModule.inspectJobsForUser(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	listWorkflowRunsForUser: (...args: Array<unknown>) =>
		mockModule.listWorkflowRunsForUser(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
}))

vi.mock('#worker/enablements/job-enablement-hint.ts', () => ({
	resolveCronJobEnablementHint: (...args: Array<unknown>) =>
		mockModule.resolveCronJobEnablementHint(...args),
}))

const { jobGetCapability } = await import('./job-get.ts')
const { jobListCapability } = await import('./job-list.ts')
const { jobRunNowCapability } = await import('./job-run-now.ts')
const { jobUpdateCapability } = await import('./job-update.ts')
const { workflowListCapability } = await import('./workflow-list.ts')

mockModule.resolveCronJobEnablementHint.mockResolvedValue(null)

const env = {} as Env
const user = {
	userId: personIdFromStored('user-123'),
	email: 'user@example.com',
	displayName: 'User Example',
}
const callerContext = createMcpCallerContext({
	source: { kind: 'mcp-oauth' },
	baseUrl: 'https://example.com',
	user,
})
const ctx = { env, callerContext }

function job(overrides: Record<string, unknown> = {}) {
	const id = String(overrides['id'] ?? 'job-123')
	return {
		id,
		name: 'Job',
		sourceId: 'source-123',
		publishedCommit: null,
		storageId: `job:${id}`,
		schedule: { type: 'interval', every: '15m' },
		scheduleSummary: 'Runs every 15m',
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: '2026-04-20T10:00:00.000Z',
		updatedAt: '2026-04-20T10:05:00.000Z',
		nextRunAt: '2026-04-20T18:30:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		runHistory: [],
		...overrides,
	}
}

function alarm(overrides: Record<string, unknown> = {}) {
	return {
		bindingAvailable: true,
		status: 'armed',
		storedUserId: 'user-123',
		alarmScheduledFor: '2026-04-20T18:30:00.000Z',
		nextRunnableJobId: 'job-123',
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: true,
		...overrides,
	}
}

function updateBody(body: Record<string, unknown>) {
	return {
		env,
		callerContext,
		body: {
			name: undefined,
			params: undefined,
			schedule: undefined,
			timezone: undefined,
			enabled: undefined,
			killSwitchEnabled: undefined,
			...body,
		},
	}
}

test('jobUpdate and jobRunNow require authentication and jobUpdate mutates existing jobs for the signed-in user', async () => {
	const unauthenticated = {
		env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
		}),
	}
	for (const capability of [jobUpdateCapability, jobRunNowCapability]) {
		await expect(
			capability.handler(
				{ id: 'job-123', enabled: false } as never,
				unauthenticated,
			),
		).rejects.toThrow('Authenticated MCP user is required for this capability.')
	}
	expect(mockModule.updateJob).not.toHaveBeenCalled()
	expect(mockModule.runJobNowViaManager).not.toHaveBeenCalled()

	mockModule.updateJob.mockResolvedValue(
		job({
			name: 'Nightly cleanup v2',
			publishedCommit: 'commit-456',
			params: { room: 'office' },
			schedule: { type: 'cron', expression: '0 3 * * *' },
			timezone: 'America/Denver',
			enabled: false,
			killSwitchEnabled: true,
			updatedAt: '2026-04-20T12:00:00.000Z',
			nextRunAt: '2026-04-21T09:00:00.000Z',
			runCount: 2,
			successCount: 1,
			errorCount: 1,
			runHistory: [
				{
					startedAt: '2026-04-20T11:00:00.000Z',
					finishedAt: '2026-04-20T11:01:00.000Z',
					status: 'error',
					durationMs: 60000,
					error: 'Timed out',
				},
			],
		}),
	)
	const result = await jobUpdateCapability.handler(
		{
			id: 'job-123',
			params: { room: 'office' },
			schedule: { type: 'cron', expression: '0 3 * * *' },
			timezone: 'America/Denver',
			enabled: false,
			kill_switch_enabled: true,
		},
		ctx,
	)
	expect(mockModule.updateJob).toHaveBeenCalledWith({
		env,
		callerContext,
		body: {
			id: 'job-123',
			params: { room: 'office' },
			schedule: { type: 'cron', expression: '0 3 * * *' },
			timezone: 'America/Denver',
			enabled: false,
			killSwitchEnabled: true,
		},
	})
	expect(result).toMatchObject({
		job_id: 'job-123',
		name: 'Nightly cleanup v2',
		source_id: 'source-123',
		published_commit: 'commit-456',
		storage_id: 'job:job-123',
		params: { room: 'office' },
		schedule: { type: 'cron', expression: '0 3 * * *' },
		timezone: 'America/Denver',
		enabled: false,
		kill_switch_enabled: true,
		expires_at: null,
		expired: false,
		created_at: '2026-04-20T10:00:00.000Z',
		updated_at: '2026-04-20T12:00:00.000Z',
		next_run_at: '2026-04-21T09:00:00.000Z',
		run_count: 2,
		success_count: 1,
		error_count: 1,
		run_history: [],
		enablement_hint: null,
	})

	mockModule.updateJob.mockResolvedValueOnce(
		job({
			id: 'job-once',
			schedule: { type: 'once', runAt: '2026-04-22T18:30:00Z' },
		}),
	)
	await jobUpdateCapability.handler(
		{
			id: 'job-once',
			schedule: { type: 'once', run_at: '2026-04-22T18:30:00Z' },
		},
		ctx,
	)
	expect(mockModule.updateJob).toHaveBeenLastCalledWith({
		env,
		callerContext,
		body: expect.objectContaining({
			id: 'job-once',
			schedule: { type: 'once', runAt: '2026-04-22T18:30:00Z' },
		}),
	})
	expect(
		mockModule.updateJob.mock.calls.at(-1)?.[0].body.schedule,
	).not.toHaveProperty('run_at')

	for (const [input, message] of [
		[{ id: 'job-123' }, 'Provide at least one mutable field to update.'],
		[
			{ id: 'job-123', code: 'export default async () => ({ ok: true })' },
			'Job code cannot be changed via jobUpdate.',
		],
		[
			{ id: 'job-123', enabled: false, code: 'export default async () => 1' },
			'Job code cannot be changed via jobUpdate.',
		],
		[
			{ id: 'job-123', name: 'Nightly cleanup v2' },
			'Job name cannot be changed via jobUpdate.',
		],
	] as const) {
		await expect(
			jobUpdateCapability.handler(input as never, ctx),
		).rejects.toThrow(message)
	}
	expect(mockModule.updateJob).toHaveBeenCalledTimes(2)
})

test('jobUpdate accepts interval and cron schedule replacements and round-trips expires_at', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-04-20T18:30:00.000Z'))
	try {
		const cases = [
			{
				input: {
					id: 'job-interval',
					schedule: { type: 'interval', every: '15m' },
				},
				body: {
					id: 'job-interval',
					schedule: { type: 'interval', every: '15m' },
				},
				returned: { nextRunAt: '2026-04-20T10:15:00.000Z' },
				expected: {
					schedule: { type: 'interval', every: '15m' },
					next_run_at: '2026-04-20T10:15:00.000Z',
				},
			},
			{
				input: {
					id: 'job-cron',
					schedule: { type: 'cron', expression: '0 9 * * 1' },
					timezone: 'America/Denver',
				},
				body: {
					id: 'job-cron',
					schedule: { type: 'cron', expression: '0 9 * * 1' },
					timezone: 'America/Denver',
				},
				returned: {
					schedule: { type: 'cron', expression: '0 9 * * 1' },
					nextRunAt: '2026-04-27T15:00:00.000Z',
				},
				expected: {
					schedule: { type: 'cron', expression: '0 9 * * 1' },
					next_run_at: '2026-04-27T15:00:00.000Z',
				},
			},
			{
				input: { id: 'job-expiring', expires_at: null },
				body: { id: 'job-expiring', expiresAt: null },
				returned: {},
				expected: { expires_at: null, expired: false },
			},
			{
				input: { id: 'job-expiring', expires_at: '2026-04-21T00:00:00Z' },
				body: { id: 'job-expiring', expiresAt: '2026-04-21T00:00:00Z' },
				returned: { expiresAt: '2026-04-21T00:00:00.000Z' },
				expected: { expires_at: '2026-04-21T00:00:00.000Z', expired: false },
			},
		]
		for (const { input, body, returned, expected } of cases) {
			mockModule.updateJob.mockResolvedValueOnce(
				job({ id: input.id, ...returned }),
			)
			const result = await jobUpdateCapability.handler(input as never, ctx)
			expect(mockModule.updateJob).toHaveBeenLastCalledWith(updateBody(body))
			expect(result).toMatchObject({ job_id: input.id, ...expected })
		}

		mockModule.inspectJobsForUser.mockResolvedValue({
			jobs: [
				job({
					id: 'job-expired',
					enabled: false,
					expiresAt: '2026-04-20T18:00:00.000Z',
					nextRunAt: '2026-04-20T19:00:00.000Z',
				}),
			],
			alarm: alarm({
				status: 'idle',
				alarmScheduledFor: null,
				nextRunnableJobId: null,
				nextRunnableRunAt: null,
			}),
		})
		const listed = await jobListCapability.handler({}, ctx)
		expect(listed.jobs[0]).toMatchObject({
			id: 'job-expired',
			expires_at: '2026-04-20T18:00:00.000Z',
			expired: true,
			due_now: false,
			enabled: false,
		})
	} finally {
		vi.useRealTimers()
	}
})

test('jobRunNow executes jobs immediately and preserves failed one-off jobs for inspection', async () => {
	const appContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user,
		storageContext: {
			sessionId: null,
			appId: 'app-123',
			packageId: null,
			storageId: null,
		},
	})
	mockModule.runJobNowViaManager.mockResolvedValueOnce({
		job: job({
			name: 'Immediate run',
			publishedCommit: 'commit-123',
			params: { room: 'office' },
			lastRunAt: '2026-04-20T10:05:00.000Z',
			lastRunStatus: 'success',
			lastDurationMs: 42,
			nextRunAt: '2026-04-20T10:20:00.000Z',
			runCount: 1,
			successCount: 1,
			runHistory: [
				{
					startedAt: '2026-04-20T10:05:00.000Z',
					finishedAt: '2026-04-20T10:05:00.000Z',
					status: 'success',
					durationMs: 42,
				},
			],
		}),
		execution: { ok: true, result: { ok: true }, logs: ['ran job'] },
		deletedAfterRun: false,
	})

	const successResult = await jobRunNowCapability.handler(
		{ id: 'job-123' },
		{ env, callerContext: appContext },
	)
	expect(mockModule.runJobNowViaManager).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-123'),
		jobId: 'job-123',
		callerContext: appContext,
	})
	expect(successResult).toMatchObject({
		job: {
			job_id: 'job-123',
			name: 'Immediate run',
			source_id: 'source-123',
			published_commit: 'commit-123',
			storage_id: 'job:job-123',
			params: { room: 'office' },
			schedule: { type: 'interval', every: '15m' },
			timezone: 'UTC',
			enabled: true,
			kill_switch_enabled: false,
			created_at: '2026-04-20T10:00:00.000Z',
			updated_at: '2026-04-20T10:05:00.000Z',
			last_run_at: '2026-04-20T10:05:00.000Z',
			last_run_status: 'success',
			last_duration_ms: 42,
			next_run_at: '2026-04-20T10:20:00.000Z',
			run_count: 1,
			success_count: 1,
			error_count: 0,
			run_history: [],
		},
		execution: { ok: true, result: { ok: true }, logs: ['ran job'] },
		deleted_after_run: false,
	})

	mockModule.runJobNowViaManager.mockResolvedValueOnce({
		job: job({
			id: 'job-once',
			schedule: { type: 'once', runAt: '2026-04-20T10:00:00.000Z' },
			lastRunAt: '2026-04-20T10:00:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'boom',
			lastDurationMs: 5,
			runCount: 1,
			errorCount: 1,
		}),
		execution: { ok: false, error: 'boom', logs: ['ran job'] },
		deletedAfterRun: false,
	})
	const failedOneOffResult = await jobRunNowCapability.handler(
		{ id: 'job-once' },
		{ env, callerContext: appContext },
	)
	expect(failedOneOffResult.deleted_after_run).toBe(false)
	expect(failedOneOffResult.execution).toEqual({
		ok: false,
		error: 'boom',
		logs: ['ran job'],
	})
	expect(failedOneOffResult.job.last_run_error).toBe('boom')
})

test('jobRunNow refuses a caller without job:execute', async () => {
	mockModule.runJobNowViaManager.mockClear()
	mockModule.authorize.mockRejectedValueOnce(
		new Error('Missing job:execute. An org Owner can grant it.'),
	)
	await expect(
		jobRunNowCapability.handler({ id: 'job-123' }, ctx),
	).rejects.toThrow('Missing job:execute')
	expect(mockModule.runJobNowViaManager).not.toHaveBeenCalled()
	mockModule.authorize.mockResolvedValue(undefined)
})

test('job inspection capabilities expose due-now state, history, alarm status, optional source code, and workflow runs', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-04-20T18:30:00.000Z'))
	const onceSchedule = { type: 'once', runAt: '2026-04-20T18:30:00.000Z' }
	mockModule.inspectJobsForUser.mockResolvedValue({
		jobs: [job({ publishedCommit: 'commit-123', schedule: onceSchedule })],
		alarm: alarm(),
	})
	mockModule.getJobInspection.mockResolvedValue({
		job: job({
			params: { bridgeId: 'ZPGI01117' },
			schedule: onceSchedule,
			lastRunAt: '2026-04-20T09:00:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'Timed out',
			lastDurationMs: 1200,
			runCount: 2,
			successCount: 1,
			errorCount: 1,
		}),
		alarm: alarm({
			status: 'out_of_sync',
			alarmScheduledFor: '2026-04-20T19:00:00.000Z',
			alarmInSync: false,
		}),
	})
	mockModule.listRunRecords.mockResolvedValue({
		runs: [
			{
				id: 'run-err-1',
				surface: 'job',
				status: 'error',
				name: 'Job',
				packageId: null,
				kodyId: null,
				sourceId: 'source-123',
				publishedCommit: null,
				storageId: 'job:job-123',
				jobId: 'job-123',
				workflowId: null,
				invocationId: null,
				sessionId: null,
				idempotencyKey: null,
				parentRunId: null,
				startedAt: '2026-04-20T08:59:58.000Z',
				finishedAt: '2026-04-20T09:00:00.000Z',
				durationMs: 1200,
				errorName: 'Error',
				errorMessage: 'Timed out',
				metadata: {},
				logCount: 2,
			},
		],
		nextCursor: null,
	})

	try {
		const listResult = await jobListCapability.handler({}, ctx)
		expect(mockModule.listRunRecords).not.toHaveBeenCalled()
		expect(mockModule.inspectJobsForUser).toHaveBeenCalledWith({
			env,
			userId: ownerIdFromStored('user-123'),
		})
		expect(listResult.jobs).toHaveLength(1)
		expect(listResult.jobs[0]).toMatchObject({
			id: 'job-123',
			source_id: 'source-123',
			published_commit: 'commit-123',
			due_now: true,
			recent_runs: [],
			enablement_hint: null,
		})
		expect(listResult.alarm).toEqual({
			binding_available: true,
			status: 'armed',
			stored_user_id: 'user-123',
			alarm_scheduled_for: '2026-04-20T18:30:00.000Z',
			next_runnable_job_id: 'job-123',
			next_runnable_run_at: '2026-04-20T18:30:00.000Z',
			alarm_in_sync: true,
		})

		const getResult = await jobGetCapability.handler({ id: 'job-123' }, ctx)
		expect(mockModule.getJobInspection).toHaveBeenCalledWith({
			env,
			userId: ownerIdFromStored('user-123'),
			jobId: 'job-123',
			includeCode: false,
		})
		expect(mockModule.listRunRecords).toHaveBeenCalledWith({
			env,
			userId: ownerIdFromStored('user-123'),
			filter: { jobId: 'job-123', surface: 'job' },
			limit: 10,
		})
		expect(getResult.job).toMatchObject({
			id: 'job-123',
			source_id: 'source-123',
			params: { bridgeId: 'ZPGI01117' },
			due_now: true,
			last_run_status: 'error',
			last_run_error: 'Timed out',
			last_duration_ms: 1200,
			enablement_hint: null,
			recent_runs: [
				{
					id: 'run-err-1',
					started_at: '2026-04-20T08:59:58.000Z',
					finished_at: '2026-04-20T09:00:00.000Z',
					status: 'error',
					duration_ms: 1200,
					error: 'Timed out',
				},
			],
		})
		expect(getResult.alarm).toEqual({
			binding_available: true,
			status: 'out_of_sync',
			stored_user_id: 'user-123',
			alarm_scheduled_for: '2026-04-20T19:00:00.000Z',
			next_runnable_job_id: 'job-123',
			next_runnable_run_at: '2026-04-20T18:30:00.000Z',
			alarm_in_sync: false,
		})

		const source = {
			entrypoint: 'src/custom-job.ts',
			code: 'export default async function main() { return { ok: true } }',
			error: null,
		}
		mockModule.getJobInspection.mockResolvedValue({
			job: job(),
			alarm: alarm(),
			source,
		})
		mockModule.listRunRecords.mockResolvedValue({ runs: [], nextCursor: null })
		const sourceResult = await jobGetCapability.handler(
			{ job_id: 'job-123', includeCode: true },
			ctx,
		)
		expect(mockModule.getJobInspection).toHaveBeenLastCalledWith({
			env,
			userId: ownerIdFromStored('user-123'),
			jobId: 'job-123',
			includeCode: true,
		})
		expect(sourceResult.source).toEqual(source)

		mockModule.listWorkflowRunsForUser.mockResolvedValue([
			{
				id: 'dynwf-123',
				userId: ownerIdFromStored('user-123'),
				sourceType: 'inline',
				packageId: null,
				kodyId: null,
				sourceId: null,
				workflowName: 'inline-code',
				exportName: null,
				idempotencyKey: 'execute-smoke',
				runAt: '2026-05-03T12:00:00.000Z',
				planDate: '2026-05-03',
				status: 'complete',
				createdAt: '2026-05-03T11:59:00.000Z',
				updatedAt: '2026-05-03T12:00:01.000Z',
				completedAt: '2026-05-03T12:00:01.000Z',
				lastError: null,
			},
		])
		const workflowListResult = await workflowListCapability.handler(
			{ limit: 5 },
			ctx,
		)
		expect(mockModule.listWorkflowRunsForUser).toHaveBeenCalledWith({
			env,
			userId: ownerIdFromStored('user-123'),
			limit: 5,
		})
		expect(workflowListResult.workflows).toEqual([
			{
				id: 'dynwf-123',
				source_type: 'inline',
				package_id: null,
				kody_id: null,
				source_id: null,
				workflow_name: 'inline-code',
				export_name: null,
				idempotency_key: 'execute-smoke',
				run_at: '2026-05-03T12:00:00.000Z',
				plan_date: '2026-05-03',
				status: 'complete',
				created_at: '2026-05-03T11:59:00.000Z',
				updated_at: '2026-05-03T12:00:01.000Z',
				completed_at: '2026-05-03T12:00:01.000Z',
				last_error: null,
			},
		])
	} finally {
		vi.useRealTimers()
	}
})

test('jobGet, jobList, and jobUpdate surface the owner enablementEnable hint', async () => {
	const hint =
		'Call enablementEnable({ packageId: "pkg-1", triggerKind: "cron", triggerName: "inbox-refresh" }) to turn on cron "inbox-refresh" for the owner. Creating a job enables it for the owner automatically; other package triggers still need an explicit enable.'
	mockModule.resolveCronJobEnablementHint.mockResolvedValue(hint)
	mockModule.inspectJobsForUser.mockResolvedValue({
		jobs: [
			job({ id: 'package-job:pkg-1:inbox-refresh', name: 'inbox-refresh' }),
		],
		alarm: alarm(),
	})
	mockModule.getJobInspection.mockResolvedValue({
		job: job({
			id: 'package-job:pkg-1:inbox-refresh',
			name: 'inbox-refresh',
		}),
		alarm: alarm(),
	})
	mockModule.listRunRecords.mockResolvedValue({ runs: [], nextCursor: null })
	mockModule.updateJob.mockResolvedValue(
		job({
			id: 'package-job:pkg-1:inbox-refresh',
			name: 'inbox-refresh',
			enabled: true,
		}),
	)

	const listed = await jobListCapability.handler({}, ctx)
	expect(listed.jobs[0]?.enablement_hint).toBe(hint)

	const got = await jobGetCapability.handler(
		{ id: 'package-job:pkg-1:inbox-refresh' },
		ctx,
	)
	expect(got.job.enablement_hint).toBe(hint)

	const updated = await jobUpdateCapability.handler(
		{ id: 'package-job:pkg-1:inbox-refresh', enabled: true },
		ctx,
	)
	expect(updated.enablement_hint).toBe(hint)
	expect(mockModule.resolveCronJobEnablementHint).toHaveBeenCalledWith(
		expect.objectContaining({
			jobId: 'package-job:pkg-1:inbox-refresh',
			jobName: 'inbox-refresh',
			enabled: true,
		}),
	)
})
