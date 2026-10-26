import {
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi, afterEach } from 'vitest'
import { getJobRowById, updateJobRow } from '@kody-internal/shared/jobs/repo.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import * as runRecords from '#worker/run-records/service.ts'
import {
	getJob,
	getJobInspection,
	inspectJobsForUser,
	runJobNow,
	syncPackageJobsForPackage,
	updateJob,
} from './service.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { jobsData } from './jobs-data.ts'
import { buildPackageJobId } from './package-job-id.ts'
import { type JobRecord, type PersistedJobCallerContext } from './types.ts'
import {
	repoMockModule,
	jobManagerMockModule,
	resetJobServiceMocks,
	mockRepoPersistence,
	createDatabase,
	createJobServiceTestEnv,
	createBundleArtifactsKv,
	insertPublishedEntitySource,
	createBaseCallerContext,
	insertPackageJob,
	withCallerUser,
} from '#worker/test-support/jobs-service.ts'

vi.mock('#worker/repo/source-service.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).sourceServiceMock(),
)
vi.mock('#worker/repo/source-sync.ts', async () =>
	(await import('#worker/test-support/jobs-service-mocks.ts')).sourceSyncMock(),
)
vi.mock('#worker/repo/artifact-repo-cleanup.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).artifactRepoCleanupMock(),
)
vi.mock('#worker/repo/repo-sessions.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionsMock(),
)
vi.mock('#worker/repo/repo-session-do.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).repoSessionDoMock(),
)
vi.mock('./manager-client.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).managerClientMock(),
)
vi.mock('#worker/identity/background-mcp-user.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).backgroundMcpUserMock(),
)
vi.mock('#worker/storage-runner.ts', async (importOriginal) =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).storageRunnerMock((await importOriginal()) as Record<string, unknown>),
)
vi.mock('#worker/worker-bundler-modules.ts', async () =>
	(
		await import('#worker/test-support/jobs-service-mocks.ts')
	).workerBundlerModulesMock(),
)
vi.mock('#worker/enablements/owner-cron-enablement.ts', () => ({
	ensureOwnerCronEnablementForJob: vi.fn(async () => 'inserted'),
	backfillOwnerCronEnablements: vi.fn(),
	resolveOwnerPersonIdForCronEnablement: vi.fn(),
}))

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite restores global spies across many integration-style tests.
afterEach(() => {
	resetJobServiceMocks()
})

const every15m = { type: 'interval', every: '15m' } as const

function setup(bindings: Partial<Env> = {}) {
	const env = createJobServiceTestEnv({
		APP_DB: createDatabase(),
		...bindings,
	})
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	return { env, callerContext, userId: callerContext.user.userId }
}

function insertJob(
	env: Env,
	callerContext: PersistedJobCallerContext,
	name: string,
	schedule: JobRecord['schedule'] = every15m,
) {
	return insertPackageJob({
		env,
		callerContext,
		body: { name, schedule },
	})
}

async function expectCallerError(promise: Promise<unknown>, message: string) {
	const error = await promise.catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({ message })
}

test('updateJob syncs the job manager alarm without republishing the package source', async () => {
	const { env, callerContext, userId } = setup({
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	})
	for (const schedule of [
		every15m,
		{ type: 'interval', every: '1h' } as const,
	]) {
		const job = await insertJob(env, callerContext, 'Fixture', schedule)
		expect(job.schedule).toEqual(schedule)
		expect(job.storageId).toBe(`job:${job.id}`)
	}
	const job = await insertJob(env, callerContext, 'sync-on-update')

	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	repoMockModule.syncArtifactSourceSnapshot.mockClear()
	await updateJob({
		env,
		callerContext,
		body: { id: job.id, schedule: { type: 'interval', every: '30m' } },
	})
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId,
	})
	expect(repoMockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('updateJob rejects another user trying to mutate a job by id', async () => {
	const { env, callerContext, userId } = setup()
	const created = await insertJob(env, callerContext, 'Owner job')
	const otherCallerContext = withCallerUser(
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-999'),
				email: 'other@example.com',
				displayName: 'Other User',
			},
			storageContext: {
				sessionId: null,
				appId: 'app-999',
				packageId: null,
				storageId: null,
			},
		}),
	)
	const notFound = `Job "${created.id}" was not found.`

	await expectCallerError(
		updateJob({
			env,
			callerContext: otherCallerContext,
			body: { id: created.id, enabled: false },
		}),
		notFound,
	)
	const inspection = await getJobInspection({
		env,
		userId: personalOrgId(userId),
		jobId: created.id,
	})
	expect(inspection.job).toMatchObject({ id: created.id, enabled: true })
})

test('missing job ids throw McpCallerError from get/inspect/run-now', async () => {
	expect.assertions(6)
	const env = createJobServiceTestEnv({ APP_DB: createDatabase() })
	const input = {
		env,
		userId: personalOrgId(createBaseCallerContext().user.userId),
		jobId: 'missing-job-id',
	}
	for (const lookup of [getJob, getJobInspection, runJobNow]) {
		await expectCallerError(
			lookup(input),
			'Job "missing-job-id" was not found.',
		)
	}
})

test('updateJob clears params, updates timezone, and disables a job', async () => {
	const { env, callerContext } = setup()
	const created = await insertPackageJob({
		env,
		callerContext,
		body: {
			name: 'mutable-job',
			params: { room: 'office' },
			schedule: { type: 'cron', expression: '0 9 * * 1' },
			timezone: 'UTC',
		},
	})

	const updated = await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			params: null,
			timezone: 'America/Denver',
			enabled: false,
		},
	})

	expect(updated.params).toBeUndefined()
	expect(updated.timezone).toBe('America/Denver')
	expect(updated.enabled).toBe(false)
})

test('updateJob saves why a job was turned off and clears it when the job turns back on', async () => {
	const { env, callerContext, userId } = setup()
	const created = await insertJob(env, callerContext, 'reasoned-job')
	const job = { env, callerContext }

	const off = await updateJob({
		...job,
		body: {
			id: created.id,
			enabled: false,
			reason: 'Paused for the migration.',
		},
	})
	expect(off.disabledReason).toBe('Paused for the migration.')
	const stored = await getJob({
		env,
		userId: personalOrgId(userId),
		jobId: created.id,
	})
	expect(stored.disabledReason).toBe('Paused for the migration.')

	// An edit that leaves the job off keeps the saved reason.
	const stillOff = await updateJob({
		...job,
		body: { id: created.id, timezone: 'America/Denver' },
	})
	expect(stillOff.disabledReason).toBe('Paused for the migration.')

	const on = await updateJob({
		...job,
		body: { id: created.id, enabled: true },
	})
	expect(on.disabledReason).toBeNull()

	// Turning it off without a reason still says how it happened.
	const offAgain = await updateJob({
		...job,
		body: { id: created.id, enabled: false },
	})
	expect(offAgain.disabledReason).toMatch(
		/^Turned off .+\. No reason was given\.$/,
	)
})

test('insertJob refuses a job id that is not a package job', async () => {
	const { env, callerContext, userId } = setup()
	const created = await insertJob(env, callerContext, 'not-a-package-job')
	const ownerId = personalOrgId(userId)
	const packageRow = await jobsData(env).getJobById({
		userId: ownerId,
		jobId: created.id,
	})
	if (!packageRow) throw new Error('Expected the inserted job row.')

	await expect(
		jobsData(env).insertJob({
			userId: ownerId,
			job: {
				...packageRow.record,
				id: 'legacy-job-id',
				storageId: 'job:legacy-job-id',
			},
			callerContextJson: JSON.stringify(callerContext),
		}),
	).rejects.toThrow('Job "legacy-job-id" is not a package job (ADR 0032).')
	await expect(
		jobsData(env).getJobById({ userId: ownerId, jobId: 'legacy-job-id' }),
	).resolves.toBeNull()
})

test('updateJob updates package-owned job metadata without force-publishing the package source', async () => {
	const { env, callerContext, userId } = setup()
	const packageId = 'pkg-1'
	const sourceId = 'package-source-1'
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		userId,
		sourceId,
		entityKind: 'package',
		entityId: packageId,
		publishedCommit: 'package-published-commit',
		manifestPath: 'package.json',
	})
	await syncPackageJobsForPackage({
		env,
		userId: personalOrgId(userId),
		baseUrl: callerContext.baseUrl,
		packageId,
		sourceId,
		manifest: parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@owner/personal-history',
				exports: { '.': './index.ts' },
				kody: {
					id: 'personal-history',
					description: 'Personal history',
					jobs: {
						'daily-prompt': {
							entry: './src/jobs/daily-prompt.ts',
							schedule: { type: 'cron', expression: '0 7 * * *' },
							enabled: false,
						},
					},
				},
			}),
		}),
	})
	const jobId = buildPackageJobId(packageId, 'daily-prompt')
	repoMockModule.syncArtifactSourceSnapshot.mockClear()

	const updated = await updateJob({
		env,
		callerContext,
		body: {
			id: jobId,
			enabled: true,
			schedule: { type: 'cron', expression: '0 8 * * *' },
			params: { date: '2026-08-18' },
		},
	})

	expect(updated).toMatchObject({
		enabled: true,
		sourceId,
		publishedCommit: 'package-published-commit',
	})
	expect(updated.schedule).toEqual({ type: 'cron', expression: '0 8 * * *' })
	expect(updated.params).toEqual({ date: '2026-08-18' })
	expect(repoMockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
	expect(
		await getJobInspection({ env, userId: personalOrgId(userId), jobId }),
	).toMatchObject({
		job: { id: jobId },
	})
})

test('inspectJobsForUser returns persisted job fields with alarm debug state', async () => {
	const { env, callerContext, userId } = setup()
	const created = await insertJob(env, callerContext, 'Inspect recurring job')
	const jobRow = await getJobRowById(env.APP_DB, userId, created.id)
	if (!jobRow) throw new Error('Expected created job row.')
	Object.assign(jobRow.record, {
		lastRunAt: '2026-04-20T10:05:00.000Z',
		lastRunStatus: 'error',
		nextRunAt: '2026-04-20T10:00:00.000Z',
		updatedAt: '2026-04-20T10:05:00.000Z',
	})
	await updateJobRow({
		db: env.APP_DB,
		userId,
		job: jobRow.record,
		callerContextJson: jobRow.callerContextJson,
	})
	const alarm = {
		bindingAvailable: true,
		status: 'armed',
		storedUserId: userId,
		alarmScheduledFor: '2026-04-20T10:00:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T10:00:00.000Z',
		alarmInSync: true,
	} as const
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue(alarm)
	const observability = {
		lastRunAt: '2026-04-20T10:05:00.000Z',
		lastRunStatus: 'error',
		lastRunError: 'Worker fetch failed',
		lastDurationMs: 321,
		runCount: 3,
		successCount: 1,
		errorCount: 2,
	} as const
	const observabilitySpy = vi
		.spyOn(runRecords, 'getJobRunObservabilityBatch')
		.mockResolvedValue([
			{
				jobId: created.id,
				...observability,
				updatedAt: '2026-04-20T10:05:00.000Z',
			},
		])

	const inspected = await inspectJobsForUser({
		env,
		userId: personalOrgId(userId),
	})

	expect(jobManagerMockModule.getJobManagerDebugState).toHaveBeenCalledWith({
		env,
		userId,
	})
	expect(observabilitySpy).toHaveBeenCalledWith({
		env,
		userId,
		jobIds: [created.id],
	})
	expect(inspected.alarm).toEqual({ ...alarm, storedUserId: 'user-123' })
	expect(inspected.jobs).toEqual([
		expect.objectContaining({
			id: created.id,
			name: 'Inspect recurring job',
			sourceId: created.sourceId,
			storageId: created.storageId,
			...observability,
		}),
	])
})

test('getJobInspection reports alarm state, source code, and artifact gaps', async () => {
	const { env, callerContext, userId } = setup({
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	})
	const created = await insertJob(env, callerContext, 'Inspect one job')
	const alarm = {
		bindingAvailable: true,
		status: 'out_of_sync',
		storedUserId: userId,
		alarmScheduledFor: '2026-04-20T18:35:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: false,
	} as const
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue(alarm)

	const inspected = await getJobInspection({
		env,
		userId: personalOrgId(userId),
		jobId: created.id,
	})

	expect(inspected.job).toMatchObject({
		id: created.id,
		name: 'Inspect one job',
		sourceId: created.sourceId,
		storageId: created.storageId,
		lastRunAt: undefined,
		lastRunStatus: undefined,
		lastRunError: undefined,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	})
	expect(inspected.alarm).toEqual({ ...alarm, storedUserId: 'user-123' })
	expect(inspected).not.toHaveProperty('source')

	const inspectCode = (jobId: string) =>
		getJobInspection({
			env,
			userId: personalOrgId(userId),
			jobId,
			includeCode: true,
		})
	const rewriteSnapshotFiles = async (
		job: { sourceId: string; publishedCommit: string | null },
		rewrite: (files: Record<string, string>) => Record<string, string>,
	) => {
		const key = buildPublishedSourceSnapshotKvKey({
			sourceId: job.sourceId,
			publishedCommit: job.publishedCommit ?? '',
		})
		const snapshot = (await env.BUNDLE_ARTIFACTS_KV.get(key, 'json')) as {
			files: Record<string, string>
		}
		await env.BUNDLE_ARTIFACTS_KV.put(
			key,
			JSON.stringify({ ...snapshot, files: rewrite(snapshot.files) }),
		)
	}

	const code =
		'export default async function main() { return { custom: true } }'
	const customJob = await insertPackageJob({
		env,
		callerContext,
		body: { name: 'custom-job', schedule: every15m, code },
	})
	expect((await inspectCode(customJob.id)).source).toEqual({
		entrypoint: 'src/job.ts',
		code,
		error: null,
	})

	const missingEntrypointJob = await insertJob(
		env,
		callerContext,
		'missing-entrypoint-job',
	)
	await rewriteSnapshotFiles(missingEntrypointJob, (files) => ({
		'package.json': files['package.json'] ?? '',
	}))
	const missingEntrypoint = await inspectCode(missingEntrypointJob.id)
	expect(missingEntrypoint.job.id).toBe(missingEntrypointJob.id)
	expect(missingEntrypoint.source).toEqual({
		entrypoint: 'src/job.ts',
		code: null,
		error: 'Job entrypoint "src/job.ts" was not found.',
	})

	const missingManifestJob = await insertJob(
		env,
		callerContext,
		'missing-manifest-job',
	)
	await rewriteSnapshotFiles(missingManifestJob, (files) => ({
		'src/job.ts': files['src/job.ts'] ?? '',
	}))
	const missingManifest = await inspectCode(missingManifestJob.id)
	expect(missingManifest.job.id).toBe(missingManifestJob.id)
	expect(missingManifest.source).toEqual({
		entrypoint: null,
		code: null,
		error: 'Job manifest "package.json" was not found.',
	})
})
