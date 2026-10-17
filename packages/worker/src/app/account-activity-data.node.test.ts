import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	loadAccountActivityData,
	readAccountActivityFilters,
	readAccountActivitySelectedRunId,
	statusFilterToRunStatus,
	surfaceFilterToRunSurface,
} from '#app/account-activity-data.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	listRunRecords: vi.fn(),
	getRunRecord: vi.fn(),
	summarizeRunRecords: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => mockModule)

type ActivityUser = Parameters<typeof loadAccountActivityData>[0]['user']

const user: ActivityUser = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	displayName: 'user',
	roles: [],
	permissions: [],
	artifactOwnerIds: [],
	mcpUser: {
		userId: personIdFromStored('stable-user-1'),
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
	request: sessionRequestContext('stable-user-1'),
}

const weekAgo = '2026-07-19T12:00:00.000Z'

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		id: 'run-1',
		surface: 'job',
		status: 'error',
		name: 'Morning digest',
		packageId: null,
		kodyId: null,
		sourceId: 'source-1',
		publishedCommit: null,
		storageId: 'storage-1',
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-25T09:00:00.000Z',
		finishedAt: '2026-07-25T09:00:01.000Z',
		durationMs: 1000,
		errorName: 'Error',
		errorMessage: 'boom',
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		metadata: {},
		logCount: 2,
		...overrides,
	}
}

function loadActivity(path: string, env = {} as Env) {
	return loadAccountActivityData({
		env,
		...readAccountActivityFilters(path),
		selectedRunId: readAccountActivitySelectedRunId(path),
		user,
		now: new Date('2026-07-26T12:00:00.000Z'),
	})
}

test('activity helpers parse filters and prefer path selected run ids', () => {
	const filterCases = [
		[
			'',
			{
				viewFilter: 'errors',
				statusFilter: 'error',
				surfaceFilter: 'all',
				triageFilter: 'open',
				cursor: null,
			},
		],
		[
			'?status=all&surface=job&cursor=abc&error_triage=ignored',
			{
				viewFilter: 'errors',
				statusFilter: 'all',
				surfaceFilter: 'job',
				triageFilter: 'ignored',
				cursor: 'abc',
			},
		],
		[
			'?view=recent',
			{
				viewFilter: 'recent',
				statusFilter: 'all',
				surfaceFilter: 'all',
				triageFilter: 'all',
				cursor: null,
			},
		],
	] as const
	for (const [query, expected] of filterCases) {
		expect(
			readAccountActivityFilters(
				`https://example.com/account/activity${query}`,
			),
		).toEqual(expected)
	}
	expect(statusFilterToRunStatus('error')).toBe('error')
	expect(statusFilterToRunStatus('success')).toBe('success')
	expect(statusFilterToRunStatus('all')).toBeNull()
	expect(surfaceFilterToRunSurface('all')).toBeNull()
	expect(surfaceFilterToRunSurface('webhook')).toBe('webhook')

	expect(
		readAccountActivitySelectedRunId(
			'https://example.com/account/activity/run-path?selected=run-query',
			'run-path-param',
		),
	).toBe('run-path-param')
	expect(
		readAccountActivitySelectedRunId(
			'https://example.com/account/activity/run-path',
		),
	).toBe('run-path')
	expect(
		readAccountActivitySelectedRunId(
			'https://example.com/account/activity?selected=run-query',
		),
	).toBe('run-query')
})

test('loadAccountActivityData maps filters, summary, pagination, detail, and cursors', async () => {
	const run = makeRun({ idempotencyKey: 'sync-account-123' })
	mockModule.summarizeRunRecords.mockResolvedValue({
		since: weekAgo,
		total: 4,
		errors: 1,
		ignored: 0,
		resolved: 0,
		running: 0,
		bySurface: [{ surface: 'job', total: 4, errors: 1 }],
	})
	mockModule.listRunRecords.mockResolvedValue({
		runs: [run],
		nextCursor: 'cursor-2',
	})
	const log = (sequence: number, level: string, message: string) => ({
		runId: run.id,
		sequence,
		level,
		message,
		fields: null,
	})
	mockModule.getRunRecord.mockResolvedValue({
		run,
		logs: [log(1, 'error', 'second'), log(0, 'log', 'first')],
	})

	const env = {} as Env
	const data = await loadActivity(
		'/account/activity/run-1?status=error&surface=job',
		env,
	)
	const owner = { env, userId: ownerIdFromStored('stable-user-1') }
	expect(mockModule.summarizeRunRecords).toHaveBeenCalledWith({
		...owner,
		since: weekAgo,
	})
	expect(mockModule.listRunRecords).toHaveBeenCalledWith({
		...owner,
		filter: {
			status: 'error',
			surface: 'job',
			since: weekAgo,
			errorTriage: 'open',
		},
		limit: 25,
		cursor: null,
	})
	expect(mockModule.getRunRecord).toHaveBeenCalledWith({
		...owner,
		runId: 'run-1',
	})
	expect(data).toMatchObject({
		ok: true,
		viewFilter: 'errors',
		statusFilter: 'error',
		surfaceFilter: 'job',
		triageFilter: 'open',
		summary: { total: 4, errors: 1, ignored: 0, resolved: 0, running: 0 },
		nextCursor: 'cursor-2',
		selectedRunId: 'run-1',
		retentionDays: 30,
		runs: [
			expect.objectContaining({
				id: 'run-1',
				surface: 'job',
				status: 'error',
				errorMessage: 'boom',
				idempotencyKey: 'sync-account-123',
				entry: null,
				workerId: null,
			}),
		],
		selectedRun: expect.objectContaining({
			id: 'run-1',
			entry: null,
			workerId: null,
			logs: [
				expect.objectContaining({ sequence: 0, message: 'first' }),
				expect.objectContaining({ sequence: 1, message: 'second' }),
			],
		}),
	})

	mockModule.listRunRecords.mockResolvedValue({ runs: [], nextCursor: null })
	mockModule.getRunRecord.mockResolvedValue(null)
	const listCases = [
		['/account/activity.json?status=all&cursor=page-2', null, 'open', 'page-2'],
		['/account/activity?view=recent', null, 'all', null],
		['/account/activity?view=recent&status=success', 'success', 'all', null],
	] as const
	for (const [path, status, errorTriage, cursor] of listCases) {
		mockModule.listRunRecords.mockClear()
		await loadActivity(path)
		expect(mockModule.listRunRecords).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: { status, surface: null, since: weekAgo, errorTriage },
				cursor,
			}),
		)
	}

	const executeRun = makeRun({
		surface: 'execute',
		name: null,
		status: 'success',
		errorName: null,
		errorMessage: null,
		jobId: null,
		metadata: {
			conversationId: 'conv-1',
			entry: 'invoke',
			invoke: 'kody:@acme/github/listRepos',
			workerId: 'kody-abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
			sandboxMs: 42,
		},
	})
	mockModule.summarizeRunRecords.mockResolvedValue({
		since: weekAgo,
		total: 1,
		errors: 0,
		ignored: 0,
		resolved: 0,
		running: 0,
		bySurface: [{ surface: 'execute', total: 1, errors: 0 }],
	})
	mockModule.listRunRecords.mockResolvedValue({
		runs: [executeRun],
		nextCursor: null,
	})
	mockModule.getRunRecord.mockResolvedValue({ run: executeRun, logs: [] })
	const executeData = await loadActivity('/account/activity/run-1?view=recent')
	expect(executeData.runs[0]).toMatchObject({
		entry: 'invoke',
		workerId: 'kody-abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
	})
	expect(executeData.selectedRun).toMatchObject({
		entry: 'invoke',
		workerId: 'kody-abcdefghijklmnopqrstuvwxyz0123456789ABCDE',
	})
})
