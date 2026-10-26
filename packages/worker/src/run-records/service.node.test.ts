import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { type RunRecordHandle } from './types.ts'

const mocks = vi.hoisted(() => ({
	dispatchRunErrorSubscriptionEvents: vi.fn(async () => []),
	finishRun: vi.fn(async () => ({ ok: true, wrote: true })),
	startRun: vi.fn(async () => ({ ok: true })),
	listRuns: vi.fn(async () => ({ runs: [], nextCursor: null })),
	listPackageRunSuccesses: vi.fn(async () => []),
	listActivationMilestones: vi.fn(async () => []),
	getAdminInsightsSnapshot: vi.fn(async () => ({
		workflowStatusCounts: [],
		activationMilestones: [],
		jobRunCounts: { success: 0, error: 0 },
	})),
	getSqlBillingStats: vi.fn(async () => ({
		databaseSize: 0,
		rowsReadTotal: 0,
		rowsWrittenTotal: 0,
		ops: [],
	})),
	inspectSqlBilling: vi.fn(async () => ({
		schemaVersion: 11,
		billing: {
			databaseSize: 0,
			rowsReadTotal: 0,
			rowsWrittenTotal: 0,
			ops: [],
		},
		runLogsIndexes: [],
		runLogsColumns: [],
		tableCounts: {
			runs: 0,
			runLogs: 0,
			packageInvocationLedger: 0,
			workflowProjections: 0,
			runDayCounts: 0,
		},
		runCount: { meta: 0, actual: 0, matches: true },
		explainRunLogsDeleteByRunId: [],
		explainRunLogsSelectByRunId: [],
	})),
}))

vi.mock('./package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: mocks.dispatchRunErrorSubscriptionEvents,
}))

const {
	beginRunRecord,
	ensureRunRecordStarted,
	finishRunRecord,
	listActivationMilestones,
	listPackageRunSuccesses,
	listRunRecords,
	recordRunRecord,
} = await import('./service.ts')

function createEnv(overrides: Partial<Env> = {}) {
	return {
		RUN_LOG: {
			idFromName: () => ({ toString: () => 'run-log-id' }),
			get: () => ({
				startRun: mocks.startRun,
				finishRun: mocks.finishRun,
				listRuns: mocks.listRuns,
				listPackageRunSuccesses: mocks.listPackageRunSuccesses,
				listActivationMilestones: mocks.listActivationMilestones,
				getAdminInsightsSnapshot: mocks.getAdminInsightsSnapshot,
				getSqlBillingStats: mocks.getSqlBillingStats,
				inspectSqlBilling: mocks.inspectSqlBilling,
			}),
		},
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
		...overrides,
	} as unknown as Env
}

test('finishRunRecord dispatches run.error.recorded only for persisted non-subscription errors', async () => {
	consoleWarn.mockImplementation(() => {})
	const env = createEnv()

	const errorHandle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: { surface: 'job', name: 'daily', jobId: 'job-1' },
	})
	expect(errorHandle).not.toBeNull()
	const timeoutError = new Error('Execution timed out after 2.5s')
	timeoutError.name = 'TimeoutError'
	await finishRunRecord({
		env,
		handle: errorHandle,
		status: 'error',
		logs: ['started context lookup'],
		error: timeoutError,
	})
	expect(mocks.finishRun).toHaveBeenCalledTimes(1)
	expect(mocks.dispatchRunErrorSubscriptionEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			run: expect.objectContaining({
				id: errorHandle!.id,
				status: 'error',
				surface: 'job',
				errorName: 'TimeoutError',
				errorMessage: 'Execution timed out after 2.5s',
			}),
		}),
	)
	expect(mocks.finishRun).toHaveBeenCalledWith({
		run: expect.objectContaining({
			errorName: 'TimeoutError',
		}),
		logs: [
			expect.objectContaining({
				level: 'log',
				message: 'started context lookup',
			}),
		],
	})

	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	const successHandle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: { surface: 'job', name: 'ok', packageId: 'pkg-a' },
	})
	await finishRunRecord({
		env,
		handle: successHandle,
		status: 'success',
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()
	expect(mocks.finishRun).toHaveBeenCalledTimes(2)

	const subscriptionHandle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: { surface: 'subscription', name: 'run.error.recorded' },
	})
	await finishRunRecord({
		env,
		handle: subscriptionHandle,
		status: 'error',
		error: new Error('handler failed'),
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()

	await recordRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: { surface: 'execute', name: 'adhoc' },
		status: 'error',
		error: new Error('execute failed'),
	})
	expect(mocks.dispatchRunErrorSubscriptionEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			run: expect.objectContaining({
				status: 'error',
				surface: 'execute',
				errorMessage: 'execute failed',
			}),
		}),
	)

	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	mocks.finishRun.mockResolvedValueOnce({ ok: true, wrote: false })
	const fencedHandle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: {
			surface: 'job',
			name: 'scheduled',
			jobId: 'job-1',
			idempotencyKey: 'scheduled-job:job-1:2026-08-21T10:00:00.000Z',
		},
	})
	await expect(
		finishRunRecord({
			env,
			handle: fencedHandle,
			status: 'error',
			error: new Error('late stranded error'),
		}),
	).resolves.toBe(false)
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()

	mocks.dispatchRunErrorSubscriptionEvents.mockClear()
	mocks.finishRun.mockRejectedValueOnce(new Error('do unavailable'))
	const rpcFailHandle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: { surface: 'job', name: 'daily' },
	})
	await expect(
		finishRunRecord({
			env,
			handle: rpcFailHandle,
			status: 'error',
			error: new Error('boom'),
		}),
	).resolves.toBe(false)
	expect(mocks.dispatchRunErrorSubscriptionEvents).not.toHaveBeenCalled()

	mocks.finishRun.mockRejectedValueOnce(new Error('do unavailable'))
	await expect(
		recordRunRecord({
			env,
			userId: ownerIdFromStored('user-1'),
			context: { surface: 'webhook', name: 'durable-hook' },
			status: 'success',
		}),
	).resolves.toBeNull()

	mocks.dispatchRunErrorSubscriptionEvents.mockRejectedValueOnce(
		new Error('dispatch exploded'),
	)
	const swallowHandle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: { surface: 'webhook', name: 'hook' },
	})
	await expect(
		finishRunRecord({
			env,
			handle: swallowHandle,
			status: 'error',
			error: new Error('boom'),
		}),
	).resolves.toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		'run-error-subscription-dispatch-failed',
		expect.any(Error),
	)
})

test('ensureRunRecordStarted reissues the running insert and swallows RPC failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const env = createEnv()
	const handle = beginRunRecord({
		env,
		userId: ownerIdFromStored('user-1'),
		context: {
			surface: 'execute',
			name: null,
			idempotencyKey: 'execute:key-1',
		},
	})
	expect(handle).not.toBeNull()
	mocks.startRun.mockClear()
	await expect(ensureRunRecordStarted({ env, handle })).resolves.toBe(true)
	expect(mocks.startRun).toHaveBeenCalledTimes(1)
	expect(mocks.startRun).toHaveBeenCalledWith(
		expect.objectContaining({
			run: expect.objectContaining({
				id: handle?.id,
				status: 'running',
				idempotencyKey: 'execute:key-1',
			}),
		}),
	)

	mocks.startRun.mockRejectedValueOnce(new Error('do unavailable'))
	await expect(ensureRunRecordStarted({ env, handle })).resolves.toBe(false)
	expect(consoleWarn).toHaveBeenCalledWith(
		'run-record-ensure-start-failed',
		expect.any(Error),
	)
	await expect(ensureRunRecordStarted({ env, handle: null })).resolves.toBe(
		false,
	)
})

test('finishRunRecord awaits the terminal Durable Object write before scheduling side effects', async () => {
	let releaseFinish!: () => void
	const finishGate = new Promise<void>((resolve) => {
		releaseFinish = resolve
	})
	const finishRun = vi.fn(async () => {
		await finishGate
		return { ok: true, wrote: true }
	})
	const env = createEnv({
		RUN_LOG: {
			idFromName: () => ({ toString: () => 'run-log-id' }),
			get: () => ({ finishRun }),
		} as unknown as Env['RUN_LOG'],
	})
	const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
	const handle: RunRecordHandle = {
		id: 'slow-export-run',
		userId: ownerIdFromStored('user-1'),
		startedAt: new Date().toISOString(),
		persistence: 'eager',
		context: { surface: 'export', name: './slow-export' },
	}

	let settled = false
	const finishing = finishRunRecord({
		env,
		handle,
		status: 'success',
		waitUntil,
	}).then(() => {
		settled = true
	})
	await Promise.resolve()
	expect(settled).toBe(false)
	expect(waitUntil).not.toHaveBeenCalled()

	releaseFinish()
	await finishing
	expect(finishRun).toHaveBeenCalledTimes(1)
	expect(waitUntil).toHaveBeenCalledTimes(1)
})

test('activation reads never throw when RunLog is missing or RPC fails', async () => {
	consoleWarn.mockImplementation(() => {})
	const envWithoutBinding = {} as Env
	await expect(
		listPackageRunSuccesses({
			env: envWithoutBinding,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toEqual([])
	await expect(
		listActivationMilestones({
			env: envWithoutBinding,
			userId: ownerIdFromStored('user-1'),
		}),
	).resolves.toEqual([])

	mocks.listPackageRunSuccesses.mockRejectedValueOnce(
		new Error('do unavailable'),
	)
	mocks.listActivationMilestones.mockRejectedValueOnce(
		new Error('do unavailable'),
	)
	const env = createEnv()
	await expect(
		listPackageRunSuccesses({ env, userId: ownerIdFromStored('user-1') }),
	).resolves.toEqual([])
	await expect(
		listActivationMilestones({ env, userId: ownerIdFromStored('user-1') }),
	).resolves.toEqual([])
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-run-successes-list-failed',
		expect.any(Error),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'activation-milestones-list-failed',
		expect.any(Error),
	)
})

test('listRunRecords normalizes since/until to UTC ISO before lexical RunLog compares', async () => {
	mocks.listRuns.mockClear()
	await listRunRecords({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		filter: {
			since: '2026-10-11T00:56:00-06:00',
			until: '2026-10-12T04:00:00Z',
		},
	})
	expect(mocks.listRuns).toHaveBeenCalledWith(
		expect.objectContaining({
			since: '2026-10-11T06:56:00.000Z',
			until: '2026-10-12T04:00:00.000Z',
		}),
	)
	await expect(
		listRunRecords({
			env: createEnv(),
			userId: ownerIdFromStored('user-1'),
			filter: { until: 'not-a-timestamp' },
		}),
	).rejects.toThrow(/Invalid ISO timestamp filter/)
})
