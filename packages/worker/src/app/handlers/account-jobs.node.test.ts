import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as appBaseUrl from '#worker/app-base-url.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const packageJob = {
	id: 'package-job:pkg-1:nightly',
	name: 'Nightly package job',
	sourceId: 'source-1',
	publishedCommit: 'commit-1',
	storageId: 'storage-1',
	params: { topic: 'news' },
	schedule: { type: 'cron' as const, expression: '0 9 * * *' },
	scheduleSummary: 'Runs on cron "0 9 * * *" in UTC',
	timezone: 'UTC',
	enabled: true,
	killSwitchEnabled: false,
	expiresAt: null,
	expired: false,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
	nextRunAt: new Date('2026-07-26T09:00:00.000Z').toISOString(),
	lastRunAt: new Date('2026-07-25T09:00:00.000Z').toISOString(),
	lastRunStatus: 'success' as const,
	lastRunError: undefined,
	lastDurationMs: 120,
	runCount: 3,
	successCount: 3,
	errorCount: 0,
	runHistory: [
		{
			startedAt: new Date('2026-07-25T09:00:00.000Z').toISOString(),
			finishedAt: new Date('2026-07-25T09:00:00.120Z').toISOString(),
			status: 'success' as const,
			durationMs: 120,
		},
	],
}

const missingPackageJob = {
	...packageJob,
	id: 'package-job:pkg-missing:hourly',
	name: 'Hourly job from a missing package',
	schedule: { type: 'interval' as const, every: '1h' },
	scheduleSummary: 'Runs every 1h',
	params: undefined,
	lastRunStatus: 'error' as const,
	lastRunError: 'boom',
	lastDurationMs: 50,
	runCount: 2,
	successCount: 1,
	errorCount: 1,
	runHistory: [
		{
			startedAt: new Date('2026-07-25T01:00:00.000Z').toISOString(),
			finishedAt: new Date('2026-07-25T01:00:00.050Z').toISOString(),
			status: 'error' as const,
			durationMs: 50,
			error: 'boom',
		},
	],
}

const alarmState = {
	bindingAvailable: true,
	status: 'armed' as const,
	storedUserId: 'stable-user-1',
	alarmScheduledFor: packageJob.nextRunAt,
	nextRunnableJobId: packageJob.id,
	nextRunnableRunAt: packageJob.nextRunAt,
	alarmInSync: true,
}

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<
		typeof authenticatedUserModule.readAuthenticatedAppUser
	>(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	})),
	inspectJobsForUser: vi.fn(),
	updateJob: vi.fn(),
	runJobNowViaManager: vi.fn(),
	getAppBaseUrl: vi.fn<typeof appBaseUrl.getAppBaseUrl>(
		() => 'https://example.com',
	),
	listRunRecords: vi.fn(),
	listSavedPackagesByUserId: vi.fn<
		typeof packageRepo.listSavedPackagesByUserId
	>(async () => [
		{
			id: 'pkg-1',
			userId: ownerIdFromStored('stable-user-1'),
			name: 'State Store',
			kodyId: 'state-store',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'source-pkg-1',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: true,
			isInternetVisible: false,
			lockedAt: null,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: (...args: Parameters<typeof appBaseUrl.getAppBaseUrl>) =>
		mockModule.getAppBaseUrl(...args),
}))

vi.mock('#worker/jobs/inspect.ts', () => ({
	inspectJobsForUser: (...args: Array<unknown>) =>
		mockModule.inspectJobsForUser(...args),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	updateJob: (...args: Array<unknown>) => mockModule.updateJob(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	runJobNowViaManager: (...args: Array<unknown>) =>
		mockModule.runJobNowViaManager(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
}))

const { testAccountJobsApiHandler } =
	await import('./account-jobs.test-support.ts')

const jobsUrl = 'https://example.com/account/jobs.json'

function stubInspection(
	jobs: Array<typeof packageJob | typeof missingPackageJob>,
) {
	mockModule.inspectJobsForUser.mockResolvedValue({ jobs, alarm: alarmState })
	mockModule.listRunRecords.mockImplementation(
		async (input: { filter?: { jobId?: string | null } }) => {
			const jobId = input.filter?.jobId
			const job = jobs.find((entry) => entry.id === jobId)
			return {
				runs: (job?.runHistory ?? []).map((entry, index) => ({
					id: `${jobId}-run-${index}`,
					surface: 'job' as const,
					status: entry.status,
					name: job?.name ?? null,
					packageId: null,
					kodyId: null,
					sourceId: job?.sourceId ?? null,
					publishedCommit: job?.publishedCommit ?? null,
					storageId: job?.storageId ?? null,
					jobId: jobId ?? null,
					workflowId: null,
					invocationId: null,
					sessionId: null,
					idempotencyKey: null,
					parentRunId: null,
					startedAt: entry.startedAt,
					finishedAt: entry.finishedAt,
					durationMs: entry.durationMs,
					errorName: 'error' in entry ? 'Error' : null,
					errorMessage: 'error' in entry ? entry.error : null,
					metadata: {},
					logCount: 0,
				})),
				nextCursor: null,
			}
		},
	)
}

function createJobsClient() {
	stubInspection([packageJob, missingPackageJob])
	const env = { APP_DB: {} as D1Database, COOKIE_SECRET: 'secret' } as Env
	const { execute } = testAccountJobsApiHandler(env)
	return {
		env,
		get: (search = '') => execute({ request: new Request(jobsUrl + search) }),
		post: (body: Record<string, unknown>) =>
			execute({
				request: new Request(jobsUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
			}),
		put: () => execute({ request: new Request(jobsUrl, { method: 'PUT' }) }),
	}
}

test('jobs API lists package jobs and selected detail', async () => {
	const { get } = createJobsClient()

	const listResponse = await get()
	expect(listResponse.status).toBe(200)
	expect(mockModule.inspectJobsForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('stable-user-1'),
	})
	const listPayload = listResponse.data as {
		jobs: Array<Record<string, unknown>>
	}
	expect(listPayload).not.toHaveProperty('retention')
	expect(listPayload).toMatchObject({
		ok: true,
		username: 'test-user',
		selectedJobId: null,
		selectedJob: null,
		jobs: [
			expect.objectContaining({
				id: 'package-job:pkg-1:nightly',
				packageId: 'pkg-1',
				packageName: 'State Store',
				packageKodyId: 'state-store',
				scheduleSummary: packageJob.scheduleSummary,
				scheduleType: 'cron',
				enabled: true,
				killSwitchEnabled: false,
				expiresAt: null,
				expired: false,
			}),
			expect.objectContaining({
				id: 'package-job:pkg-missing:hourly',
				packageId: 'pkg-missing',
				packageName: null,
				packageKodyId: null,
				scheduleType: 'interval',
			}),
		],
		alarm: expect.objectContaining({
			bindingAvailable: true,
			status: 'armed',
		}),
	})
	for (const job of listPayload.jobs) {
		expect(job).not.toHaveProperty('ownership')
		expect(job).not.toHaveProperty('preserved')
	}

	const detailResponse = await get(
		`?selected=${encodeURIComponent(packageJob.id)}`,
	)
	expect(detailResponse.status).toBe(200)
	expect(detailResponse.data).toMatchObject({
		ok: true,
		selectedJobId: packageJob.id,
		selectedJob: expect.objectContaining({
			id: packageJob.id,
			packageId: 'pkg-1',
			params: { topic: 'news' },
			schedule: { type: 'cron', expression: '0 9 * * *' },
			recentRuns: [
				expect.objectContaining({
					id: `${packageJob.id}-run-0`,
					status: 'success',
					durationMs: 120,
					error: null,
				}),
			],
			storageId: 'storage-1',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
		}),
	})
})

test('jobs API rejects unauthenticated, unsupported, and removed actions', async () => {
	const { get, post, put } = createJobsClient()

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	expect((await get()).status).toBe(401)
	expect((await put()).status).toBe(405)

	for (const body of [
		{ action: 'nope' },
		{ action: 'set_enabled', id: packageJob.id, enabled: false },
		{ action: 'set_preserved', id: packageJob.id, preserved: true },
		{
			action: 'update_retention',
			successOnceDays: 14,
			failedOrNeverRanOnceDays: 60,
			disabledRecurringDays: 90,
		},
		{ action: 'delete', id: packageJob.id },
	]) {
		const response = await post(body)
		expect([body.action, response.status]).toEqual([body.action, 400])
		expect(response.data).toEqual({
			ok: false,
			error: 'Invalid action.',
		})
	}
	expect(mockModule.updateJob).not.toHaveBeenCalled()
})

test('jobs API kill switch and run now are user-scoped', async () => {
	const { env, post } = createJobsClient()
	mockModule.runJobNowViaManager.mockResolvedValue({
		job: packageJob,
		execution: { ok: true, logs: [] },
		deletedAfterRun: false,
	})

	mockModule.updateJob.mockResolvedValue({
		...packageJob,
		killSwitchEnabled: true,
	})
	const killSwitchResponse = await post({
		action: 'set_kill_switch',
		id: packageJob.id,
		killSwitchEnabled: true,
	})
	expect(killSwitchResponse.status).toBe(200)
	expect(mockModule.updateJob).toHaveBeenLastCalledWith(
		expect.objectContaining({
			env,
			callerContext: expect.objectContaining({
				baseUrl: 'https://example.com',
				user: expect.objectContaining({
					userId: ownerIdFromStored('stable-user-1'),
				}),
			}),
			body: { id: packageJob.id, killSwitchEnabled: true },
		}),
	)

	const runNowResponse = await post({ action: 'run_now', id: packageJob.id })
	expect(runNowResponse.status).toBe(200)
	expect(mockModule.runJobNowViaManager).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('stable-user-1'),
			jobId: packageJob.id,
		}),
	)
	expect(runNowResponse.data).toMatchObject({
		ok: true,
		runNow: { ok: true, deletedAfterRun: false },
	})
})

test('accepted job changes do not depend on a jobs page read', async () => {
	const { post } = createJobsClient()
	const original = mockModule.inspectJobsForUser.getMockImplementation()
	mockModule.inspectJobsForUser.mockRejectedValue(new Error('Page unavailable'))
	mockModule.inspectJobsForUser.mockClear()
	mockModule.updateJob.mockResolvedValue(packageJob)
	mockModule.runJobNowViaManager.mockResolvedValue({
		job: packageJob,
		execution: { ok: true, logs: [] },
		deletedAfterRun: true,
	})
	try {
		const switched = await post({
			action: 'set_kill_switch',
			id: packageJob.id,
			killSwitchEnabled: true,
		})
		expect(switched.status).toBe(200)
		expect(switched.data).toEqual({
			ok: true,
			jobId: packageJob.id,
			killSwitchEnabled: true,
		})
		const ran = await post({ action: 'run_now', id: packageJob.id })
		expect(ran.status).toBe(200)
		expect(ran.data).toEqual({
			ok: true,
			jobId: packageJob.id,
			runNow: { ok: true, error: null, deletedAfterRun: true },
		})
		expect(mockModule.inspectJobsForUser).not.toHaveBeenCalled()
	} finally {
		mockModule.inspectJobsForUser.mockImplementation(original!)
	}
})
