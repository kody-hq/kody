import {
	ownerIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { inheritRequest } from '#worker/request-context/request-context.ts'
import { expect, test, vi, afterEach } from 'vitest'
import { getJobRowById } from '@kody-internal/shared/jobs/repo.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import * as registry from '#mcp/run-kody-registry.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import { createMcpCallerContext } from '#worker/mcp/context.ts'
import { planLimits } from '#universal/plans.ts'
import {
	AccountSuspendedError,
	accountSuspendedMessage,
} from '#worker/account/account-suspension.ts'
import { d1NetworkConnectionLostMessage } from '#worker/d1-retry.ts'
import { parseEntitlementLimitMessage } from '#worker/entitlements/errors.ts'
import * as moduleGraph from '#worker/package-runtime/module-graph.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import * as repoKodyExecution from '#worker/repo/repo-kody-execution.ts'
import { durableObjectInstanceInactiveCloseMessage } from '#worker/sentry-options.ts'
import { createStorageEstimateReadError } from '#worker/storage-estimate-error.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import * as usageModule from '#worker/usage/record-usage.ts'
import { TransientJobExecutionError } from './execution-safety.ts'
import { buildPackageJobId } from './package-job-id.ts'
import * as schedule from './schedule.ts'
import { executeJobOnce, runJobNow, updateJob } from './service.ts'
import { type JobRecord, type PersistedJobCallerContext } from './types.ts'
import {
	identityMockModule,
	resetJobServiceMocks,
	mockRepoPersistence,
	createPackageJobManifestText,
	createDatabase,
	createJobServiceTestEnv,
	createStorageRunnerBinding,
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

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite restores global spies across many integration-style tests.
afterEach(() => {
	resetJobServiceMocks()
})

const onceSchedule = { type: 'once', runAt: '2026-04-17T15:00:00Z' } as const

function createExecuteEnv(
	initialRows: Parameters<typeof createDatabase>[0] = {},
) {
	const db = createDatabase(initialRows)
	const bundleKv = createBundleArtifactsKv()
	const env = createJobServiceTestEnv({
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
		STORAGE_RUNNER: createStorageRunnerBinding(),
	})
	return { db, bundleKv, env }
}

function createJob(
	input: Pick<JobRecord, 'id' | 'name' | 'sourceId'> & Partial<JobRecord>,
): JobRecord {
	return {
		version: 1,
		userId: ownerIdFromStored('user-123'),
		publishedCommit: null,
		storageId: `job:${input.id}`,
		schedule: onceSchedule,
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		expiresAt: null,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
		...input,
	}
}

/** Package job inserted with a published package.json snapshot. */
async function publishInsertedPackageJob(input: {
	env: Env
	callerContext: PersistedJobCallerContext
	name: string
	code: string
	params?: Record<string, unknown>
	schedule?: JobRecord['schedule']
}) {
	mockRepoPersistence()
	const jobView = await insertPackageJob({
		env: input.env,
		callerContext: input.callerContext,
		body: {
			name: input.name,
			code: input.code,
			params: input.params,
			schedule: input.schedule ?? onceSchedule,
		},
	})
	const row = await getJobRowById(
		input.env.APP_DB,
		input.callerContext.user.userId,
		jobView.id,
	)
	if (!row) throw new Error('Expected created job row.')
	return { jobView, row }
}

/** Package-backed job whose published package.json declares `jobName`. */
async function publishPackageJob(input: {
	id: string
	sourceId: string
	commit: string
	kodyId: string
	jobName: string
	files: Record<string, string>
	manifest?: { entry?: string; exportPath?: string }
	job?: Partial<JobRecord>
}) {
	const { db, bundleKv, env } = createExecuteEnv()
	await insertPublishedEntitySource({
		db,
		userId: ownerIdFromStored('user-123'),
		sourceId: input.sourceId,
		entityKind: 'package',
		entityId: input.id,
		publishedCommit: input.commit,
		manifestPath: 'package.json',
		kv: bundleKv,
		files: {
			'package.json': createPackageJobManifestText({
				packageName: `@kody/${input.kodyId}`,
				kodyId: input.kodyId,
				description: 'Runs from repo',
				jobName: input.jobName,
				...input.manifest,
			}),
			...input.files,
		},
	})
	const job = createJob({
		id: input.id,
		name: input.jobName,
		sourceId: input.sourceId,
		publishedCommit: input.commit,
		...input.job,
	})
	return { db, env, job }
}

test('executeJobOnce gates entitlement, identity blips, and suspension before sandbox work', async () => {
	// Usage rollup writes are best-effort and fail against this fake env.
	silenceIncidentalRuntimeWarnings()
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const executeSpy = vi.spyOn(registry, 'runBundledModuleWithRegistry')
	const callerContext = createBaseCallerContext()
	const userId = callerContext.user.userId
	const intervalJob = (id: string) =>
		createJob({
			id,
			name: id,
			sourceId: `source-${id}`,
			schedule: { type: 'interval', every: '1h' },
		})

	// job_runs_per_day entitlement. Email matches the module-level
	// resolveBackgroundMcpUser mock.
	const meter = createInMemoryUserMeterEnv()
	const quotaEnv = createJobServiceTestEnv(
		{
			APP_DB: createDatabase({
				users: [
					{
						email: `${userId}@example.com`,
						plan: 'free',
						stable_user_id: userId,
					},
				],
			}),
		},
		meter,
	)
	const limit = planLimits.free.maxJobRunsPerDay
	await meter.seed({
		userId,
		resource: 'job_runs_per_day',
		day: utcDayKey(),
		count: limit,
	})
	const quota = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env: quotaEnv,
		job: intervalJob('job-run-quota'),
		callerContext,
	})
	if (quota.execution.ok) throw new Error('Expected job_runs_per_day denial.')
	expect(parseEntitlementLimitMessage(quota.execution.error)).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'job_runs_per_day',
		plan: 'free',
		limit,
		current: limit,
	})

	// Transient background identity lookup failures are retried by the caller.
	const env = createJobServiceTestEnv({ APP_DB: createDatabase() })
	identityMockModule.resolveBackgroundMcpUser.mockRejectedValueOnce(
		new Error('D1_ERROR: Network connection lost.'),
	)
	await expect(
		executeJobOnce({
			source: { kind: 'schedule', jobId: 'test-job' },
			env,
			job: intervalJob('job-identity-retry'),
			callerContext,
		}),
	).rejects.toBeInstanceOf(TransientJobExecutionError)

	// A suspended owner halts the job.
	identityMockModule.resolveBackgroundMcpUser.mockRejectedValueOnce(
		new AccountSuspendedError(),
	)
	const suspended = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env,
		job: intervalJob('job-suspended'),
		callerContext,
	})
	expect(suspended.execution).toMatchObject({
		ok: false,
		error: accountSuspendedMessage,
	})

	expect(executeSpy).not.toHaveBeenCalled()
	expect(recordUsageSpy).not.toHaveBeenCalled()
})

test('interactive-origin package jobs run in the background with writable storage and execute-style invoke tools', async () => {
	// Usage rollup writes are best-effort and fail against this fake env.
	silenceIncidentalRuntimeWarnings()
	const { env } = createExecuteEnv()
	const callerContext = {
		...createBaseCallerContext(),
		executionOrigin: 'interactive' as const,
	}
	const code =
		'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }'
	const { jobView, row } = await publishInsertedPackageJob({
		env,
		callerContext,
		name: 'storage-bridge',
		code,
		params: { stepCount: 2 },
	})
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({
			result: { value: 2 },
			logs: ['storage helper executed'],
		})

	expect(row.record.storageId).toBe(`job:${jobView.id}`)
	expect(row.callerContext?.executionOrigin).toBe('interactive')
	const outcome = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env,
		job: row.record,
		callerContext: row.callerContext,
	})

	expect(outcome.execution).toEqual({
		ok: true,
		result: { value: 2 },
		logs: ['storage helper executed'],
	})
	expect(executeSpy).toHaveBeenCalledWith(
		env,
		expect.objectContaining({
			executionOrigin: 'background',
			user: expect.objectContaining({
				userId: callerContext.user.userId,
				email: 'user-123@example.com',
			}),
		}),
		expect.any(Object),
		expect.any(Object),
		expect.not.objectContaining({
			packageInvokeTools: expect.anything(),
		}),
	)
	expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
		executorTimeoutMs: backgroundExecutorTimeoutMs,
	})
})

test('executeJobOnce records job_run usage for success and failure', async () => {
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const { env } = createExecuteEnv()
	const callerContext = createBaseCallerContext()
	const { jobView, row } = await publishInsertedPackageJob({
		env,
		callerContext,
		name: 'usage-metered-job',
		code: 'export default async () => ({ ok: true, metered: true })',
	})
	vi.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValueOnce({
			result: { ok: true, metered: true },
			logs: ['metered job executed'],
		})
		.mockResolvedValueOnce({
			error: 'metered job failed',
			result: null,
			logs: ['metered job error'],
		})

	const cases = [
		[
			'success',
			{
				ok: true,
				result: { ok: true, metered: true },
				logs: ['metered job executed'],
			},
		],
		[
			'error',
			{ ok: false, error: 'metered job failed', logs: ['metered job error'] },
		],
	] as const
	for (const [usageOutcome, execution] of cases) {
		recordUsageSpy.mockClear()
		const outcome = await executeJobOnce({
			source: { kind: 'schedule', jobId: 'test-job' },
			env,
			job: row.record,
			callerContext,
		})
		expect(outcome.execution).toEqual(execution)
		expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(env, {
			userId: row.record.userId,
			actorUserId: '',
			automationSource: 'schedule',
			eventType: 'job_run',
			entityId: jobView.id,
			durationMs: outcome.durationMs,
			outcome: usageOutcome,
		})
	}
})

test('package-backed jobs execute from published package.json manifests', async () => {
	silenceIncidentalRuntimeWarnings()
	const executeSpy = vi.spyOn(registry, 'runBundledModuleWithRegistry')
	const policyError =
		'Secret "apiToken" is not allowed for host "api.example.com".'
	const cases: Array<{
		id: string
		kodyId: string
		jobName: string
		manifest: { entry?: string; exportPath?: string }
		files: Record<string, string>
		run: Awaited<ReturnType<typeof registry.runBundledModuleWithRegistry>>
		expected: unknown
	}> = [
		{
			id: 'job-repo-1',
			kodyId: 'repo-backed-job',
			jobName: 'Repo-backed job',
			manifest: { entry: './src/job.ts' },
			files: {
				'src/job.ts':
					'export default async () => ({ ok: true, repoBacked: true })',
			},
			run: { result: { ok: true, repoBacked: true }, logs: ['ran'] },
			expected: {
				ok: true,
				result: { ok: true, repoBacked: true },
				logs: ['ran'],
			},
		},
		{
			// Custom job entry file outside the default src/job.ts.
			id: 'job-repo-typecheck-strict',
			kodyId: 'repo-typecheck-strict',
			jobName: 'Repo-backed strict typecheck job',
			manifest: { entry: './src/custom-job.ts' },
			files: {
				'src/custom-job.ts': 'export default async () => ({ ok: true })',
			},
			run: { result: { ok: true }, logs: ['ran'] },
			expected: { ok: true, result: { ok: true }, logs: ['ran'] },
		},
		{
			// Package export path distinct from the job entry.
			id: 'job-repo-absolute-paths',
			kodyId: 'repo-absolute-path-job',
			jobName: 'Repo-backed absolute path job',
			manifest: { exportPath: './src/job.ts' },
			files: {
				'src/job.ts':
					'export default async () => ({ ok: true, normalized: true })',
			},
			run: { result: { ok: true, normalized: true }, logs: ['ran'] },
			expected: {
				ok: true,
				result: { ok: true, normalized: true },
				logs: ['ran'],
			},
		},
		{
			// Sandbox policy errors surface as job failures without logs.
			id: 'job-1',
			kodyId: 'forbidden-secret-access',
			jobName: 'Forbidden secret access',
			manifest: {},
			files: { 'src/job.ts': 'export default async () => ({ ok: true })' },
			run: { result: undefined, error: policyError, logs: [] },
			expected: { ok: false, error: policyError, logs: [] },
		},
	]

	const outcomes = []
	for (const row of cases) {
		const { env, job } = await publishPackageJob({
			id: row.id,
			sourceId: `source-${row.id}`,
			commit: `commit-${row.id}`,
			kodyId: row.kodyId,
			jobName: row.jobName,
			manifest: row.manifest,
			files: row.files,
		})
		executeSpy.mockResolvedValueOnce(row.run)
		const outcome = await executeJobOnce({
			source: { kind: 'schedule', jobId: 'test-job' },
			env,
			job,
			callerContext: createBaseCallerContext(),
		})
		outcomes.push([row.id, outcome.execution])
	}
	expect(outcomes).toEqual(cases.map((row) => [row.id, row.expected]))
	expect(executeSpy).toHaveBeenCalledTimes(cases.length)
})

test('package-backed jobs with a stored typecheck bypass policy still surface executor failures', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env, job } = await publishPackageJob({
		id: 'job-repo-typecheck-bypass',
		sourceId: 'source-bypass',
		commit: 'commit-bypass',
		kodyId: 'repo-typecheck-bypass',
		jobName: 'Repo-backed bypass typecheck job',
		files: {
			'src/job.ts': 'export default async () => ({ ok: true, bypassed: true })',
		},
		job: { repoCheckPolicy: { allowTypecheckFailures: true } },
	})
	const callerContext = createBaseCallerContext()
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({
			result: { ok: true, bypassed: true },
			logs: ['repo-backed kody executed'],
		})
	const formatJobErrorSpy = vi.spyOn(schedule, 'formatJobError')

	expect(
		(
			await executeJobOnce({
				env,
				job,
				callerContext,
				source: { kind: 'schedule', jobId: 'test-job' },
			})
		).execution,
	).toEqual({
		ok: true,
		result: { ok: true, bypassed: true },
		logs: ['repo-backed kody executed'],
	})
	expect(executeSpy).toHaveBeenCalledTimes(1)

	executeSpy.mockRejectedValueOnce(new Error('Executor import failed'))
	expect(
		(
			await executeJobOnce({
				env,
				job,
				callerContext,
				source: { kind: 'schedule', jobId: 'test-job' },
			})
		).execution,
	).toEqual({
		ok: false,
		error: 'Executor import failed',
		logs: [],
	})
	expect(formatJobErrorSpy).toHaveBeenCalled()
})

test('package-backed ESM jobs bundle the package entry and use runtime invoke tools', async () => {
	silenceIncidentalRuntimeWarnings()
	const moduleSource =
		'export default async () => ({ ok: true, repoBacked: "module" })'
	const { env, job } = await publishPackageJob({
		id: 'job-repo-module',
		sourceId: 'source-job-repo-module',
		commit: 'commit-abc',
		kodyId: 'repo-module-job',
		jobName: 'Repo-backed module job',
		files: {
			'src/job.ts': moduleSource,
			'src/lib.ts': 'export const value = 1',
		},
	})
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({
			result: { ok: true, repoBacked: 'module' },
			logs: ['repo-backed kody executed'],
		})
	vi.spyOn(
		repoKodyExecution,
		'loadRepoSourceFilesFromSession',
	).mockResolvedValue({
		'package.json': JSON.stringify({ name: 'repo-module-job', private: true }),
		'src/job.ts': moduleSource,
		'src/lib.ts': 'export const value = 1',
	})
	vi.spyOn(moduleGraph, 'buildKodyModuleBundle').mockResolvedValue({
		mainModule: 'dist/job.js',
		modules: { 'dist/job.js': moduleSource },
		dependencies: [],
	})

	const outcome = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env,
		job,
		callerContext: createBaseCallerContext(),
	})

	expect(outcome.execution).toEqual({
		ok: true,
		result: { ok: true, repoBacked: 'module' },
		logs: ['repo-backed kody executed'],
	})
	expect(executeSpy).toHaveBeenCalledTimes(1)
	expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
		packageContext: { packageId: 'job-repo-module', kodyId: 'repo-module-job' },
		packageEventTools: expect.objectContaining({
			dispatch: expect.any(Function),
		}),
	})
	expect(executeSpy.mock.calls[0]?.[4]).not.toHaveProperty('packageInvokeTools')
})

test('stale published job bundles rebuild after the source commit changes', async () => {
	silenceIncidentalRuntimeWarnings()
	const { db, bundleKv, env } = createExecuteEnv()
	const publish = (commit: string, jobSource: string) =>
		insertPublishedEntitySource({
			db,
			userId: ownerIdFromStored('user-123'),
			sourceId: 'source-stale-bundle',
			entityKind: 'package',
			entityId: 'pkg-stale-bundle',
			publishedCommit: commit,
			manifestPath: 'package.json',
			kv: bundleKv,
			files: {
				'package.json': createPackageJobManifestText({
					packageName: '@kody/stale-bundle',
					kodyId: 'stale-bundle',
					description: 'Runs stale bundle test',
					jobName: 'stale-bundle-job',
					exportPath: './src/job.ts',
				}),
				'src/job.ts': jobSource,
			},
		})
	await publish('commit-1', 'export default async () => ({ version: "old" })')
	const source = await getEntitySourceById(db, 'source-stale-bundle')
	if (!source) throw new Error('Expected source row.')
	await persistPublishedBundleArtifact({
		env: { APP_DB: db, BUNDLE_ARTIFACTS_KV: bundleKv } as Env,
		userId: ownerIdFromStored('user-123'),
		source,
		kind: 'job',
		artifactName: 'stale-bundle-job',
		entryPoint: 'src/job.ts',
		mainModule: 'dist/bundled-entry.js',
		modules: {
			'dist/bundled-entry.js':
				'export default async () => ({ version: "old-bundle" })',
		},
		dependencies: [],
		packageContext: {
			packageId: 'pkg-stale-bundle',
			kodyId: 'stale-bundle',
			sourceId: 'source-stale-bundle',
		},
	})
	await publish(
		'commit-2',
		'export default async () => { console.log("canary"); return { version: "new" } }',
	)
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({
			result: { ok: true, version: 'new' },
			logs: ['canary'],
		})

	const outcome = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env,
		job: createJob({
			id: buildPackageJobId('pkg-stale-bundle', 'stale-bundle-job'),
			name: 'stale-bundle-job',
			sourceId: 'source-stale-bundle',
			publishedCommit: 'commit-2',
		}),
		callerContext: createBaseCallerContext(),
	})

	expect(outcome.execution).toEqual({
		ok: true,
		result: { ok: true, version: 'new' },
		logs: ['canary'],
	})
	expect(executeSpy).toHaveBeenCalledTimes(1)
	const executedModules = Object.values(
		executeSpy.mock.calls[0]?.[2]?.modules ?? {},
	).join('\n')
	expect(executedModules).toContain('userEntrypoint')
	expect(executedModules).not.toContain('old-bundle')
})

test('executeJobOnce reports a missing published snapshot without running the sandbox', async () => {
	silenceIncidentalRuntimeWarnings()
	const { db, env } = createExecuteEnv()
	await insertPublishedEntitySource({
		db,
		userId: ownerIdFromStored('user-123'),
		sourceId: 'source-1',
		entityKind: 'package',
		entityId: 'job-repo-discard-failure',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
	})
	const formatJobErrorSpy = vi.spyOn(schedule, 'formatJobError')
	const executeSpy = vi.spyOn(registry, 'runBundledModuleWithRegistry')

	const outcome = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env,
		job: createJob({
			id: 'job-repo-discard-failure',
			name: 'Repo-backed job discard failure',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
		}),
		callerContext: createBaseCallerContext(),
	})

	expect(outcome.execution).toEqual({
		ok: false,
		error:
			'Published snapshot for package "job-repo-discard-failure" at commit "commit-1" is missing and could not be recovered from the artifact repo. Republish the package to restore it.',
		logs: [],
	})
	expect(executeSpy).not.toHaveBeenCalled()
	expect(formatJobErrorSpy).toHaveBeenCalled()
})

test('executeJobOnce loads the published source by job owner id, not the caller person', async () => {
	silenceIncidentalRuntimeWarnings()
	const orgId = ownerIdFromStored('org-owner')
	const { db, env } = createExecuteEnv({
		orgs: [{ id: orgId, slug: 'org-owner', plan: 'free' }],
	})
	await insertPublishedEntitySource({
		db,
		userId: orgId,
		sourceId: 'source-org',
		entityKind: 'package',
		entityId: 'pkg-org',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
	})

	const outcome = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'job-org' },
		env,
		job: createJob({
			id: 'job-org',
			name: 'Org job',
			sourceId: 'source-org',
			publishedCommit: 'commit-1',
			userId: orgId,
		}),
		callerContext: createBaseCallerContext(),
	})

	expect(outcome.execution).toEqual({
		ok: false,
		error:
			'Published snapshot for package "pkg-org" at commit "commit-1" is missing and could not be recovered from the artifact repo. Republish the package to restore it.',
		logs: [],
	})
})

test('executeJobOnce forwards waitUntil to the registry for claimed scheduled runs', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env } = createExecuteEnv()
	const callerContext = createBaseCallerContext()
	const { row } = await publishInsertedPackageJob({
		env,
		callerContext,
		name: 'claimed-waituntil-job',
		code: 'export default async () => ({ ok: true })',
		schedule: { type: 'interval', every: '15m' },
	})
	const claimedHandle = {
		id: 'run-claimed-waituntil',
		userId: personalOrgId(callerContext.user.userId),
		startedAt: '2026-08-21T14:40:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'job' as const,
			name: row.record.name,
			jobId: row.record.id,
			storageId: row.record.storageId,
		},
	}
	const waitUntil = vi.fn<(promise: Promise<unknown>) => void>()
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({ result: { ok: true }, logs: [] })

	const outcome = await executeJobOnce({
		env,
		job: row.record,
		callerContext,
		runRecordHandle: claimedHandle,
		waitUntil,
		source: { kind: 'schedule', jobId: row.record.id },
	})

	expect(outcome.execution).toEqual({
		ok: true,
		result: { ok: true },
		logs: [],
	})
	expect(executeSpy).toHaveBeenCalledTimes(1)
	expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
		runRecordHandle: claimedHandle,
		waitUntil,
	})
})

test('executeJobOnce retries claimed platform blips and surfaces them on run-now', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env } = createExecuteEnv()
	const callerContext = createBaseCallerContext()
	const { row } = await publishInsertedPackageJob({
		env,
		callerContext,
		name: 'platform-blip-retry-job',
		code: 'export default async () => ({ ok: true })',
		schedule: { type: 'interval', every: '15m' },
	})
	const estimateError = createStorageEstimateReadError({
		storageId: 'package:estimate-target',
		attempts: 4,
		cause: new Error('Storage estimate read timed out after 2000ms.'),
	})
	const executeSpy = vi.spyOn(registry, 'runBundledModuleWithRegistry')
	const claimedHandle = {
		id: 'run-platform-blip-claimed',
		userId: personalOrgId(callerContext.user.userId),
		startedAt: '2026-08-21T14:40:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'job' as const,
			name: row.record.name,
			jobId: row.record.id,
			storageId: row.record.storageId,
		},
	}
	const run = (runRecordHandle?: typeof claimedHandle) =>
		executeJobOnce({
			env,
			job: row.record,
			callerContext,
			runRecordHandle,
			source: { kind: 'schedule', jobId: 'test-job' },
		})

	for (const error of [
		estimateError.message,
		durableObjectInstanceInactiveCloseMessage,
		`D1_ERROR: ${d1NetworkConnectionLostMessage}.`,
	]) {
		executeSpy.mockResolvedValue({ result: undefined, error, logs: [] })
		expect((await run()).execution).toEqual({ ok: false, error, logs: [] })
		await expect(run(claimedHandle)).rejects.toBeInstanceOf(
			TransientJobExecutionError,
		)
	}

	executeSpy.mockResolvedValue({
		result: undefined,
		error: 'user code failed',
		logs: [],
	})
	expect((await run(claimedHandle)).execution).toEqual({
		ok: false,
		error: 'user code failed',
		logs: [],
	})
})

test('runJobNow refuses a run that has no person', async () => {
	silenceIncidentalRuntimeWarnings()
	const { env } = createExecuteEnv()
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await insertPackageJob({
		env,
		callerContext,
		body: { name: 'runs-as-nobody', schedule: onceSchedule },
	})
	const executeSpy = vi.spyOn(registry, 'runBundledModuleWithRegistry')
	const actorless = {
		...callerContext,
		request: {
			...callerContext.request!,
			actor: null,
			attribution: {
				kind: 'automation' as const,
				source: 'schedule' as const,
				sourceId: jobView.id,
			},
		},
	}

	await expect(
		runJobNow({
			env,
			userId: personalOrgId(callerContext.user.userId),
			jobId: jobView.id,
			callerContext: actorless as never,
		}),
	).rejects.toThrow('can only be run now by a signed-in person')
	await expect(
		runJobNow({
			env,
			userId: personalOrgId(callerContext.user.userId),
			jobId: jobView.id,
		}),
	).rejects.toThrow('can only be run now by a signed-in person')
	expect(executeSpy).not.toHaveBeenCalled()
})

test('runJobNow keeps once jobs instead of deleting them', async () => {
	silenceIncidentalRuntimeWarnings()
	const { db, env: baseEnv } = createExecuteEnv()
	const deleteByIds = vi.fn(async () => {})
	const env = {
		...baseEnv,
		CAPABILITY_VECTOR_INDEX: { deleteByIds } as unknown as VectorizeIndex,
	}
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await insertPackageJob({
		env,
		callerContext,
		body: { name: 'run-once-and-retain', schedule: onceSchedule },
	})
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({
			result: { ok: true },
			logs: [],
		})

	const result = await runJobNow({
		env,
		userId: personalOrgId(callerContext.user.userId),
		jobId: jobView.id,
		callerContext,
	})

	expect(result.execution).toEqual({
		ok: true,
		result: { ok: true },
		logs: [],
	})
	expect(result.deletedAfterRun).toBe(false)
	const runRequest = executeSpy.mock.lastCall?.[1].request
	expect(runRequest?.attribution).toEqual(callerContext.request?.attribution)
	expect(runRequest?.credential).toEqual(callerContext.request?.credential)
	expect(deleteByIds).not.toHaveBeenCalled()
	const row = await getJobRowById(db, callerContext.user.userId, jobView.id)
	expect(row?.record).toEqual(
		expect.objectContaining({
			id: jobView.id,
			enabled: false,
			lastRunStatus: 'success',
			lastRunAt: expect.any(String),
			// RunLog-owned counters/error/duration stay at insert defaults.
			runCount: 0,
			successCount: 0,
			errorCount: 0,
			lastRunError: undefined,
			lastDurationMs: undefined,
		}),
	)
})

test('runJobNow can use a one-off repo check policy override without changing the stored job', async () => {
	silenceIncidentalRuntimeWarnings()
	const { db, env } = createExecuteEnv()
	const callerContext = createBaseCallerContext()
	mockRepoPersistence()
	const jobView = await insertPackageJob({
		env,
		callerContext,
		body: {
			name: 'run-now-override',
			code: 'export default async function run() { return { ok: true, override: true } }',
			schedule: { type: 'interval', every: '15m' },
		},
	})
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({
			result: { ok: true, override: true },
			logs: ['repo-backed kody executed'],
		})

	const result = await runJobNow({
		env,
		userId: personalOrgId(callerContext.user.userId),
		jobId: jobView.id,
		callerContext,
		repoCheckPolicyOverride: { allowTypecheckFailures: true },
	})

	expect(result.execution).toEqual({
		ok: true,
		result: { ok: true, override: true },
		logs: ['repo-backed kody executed'],
	})
	const row = await getJobRowById(db, callerContext.user.userId, jobView.id)
	expect(row?.record.repoCheckPolicy).toBeUndefined()
	expect(executeSpy).toHaveBeenCalledTimes(1)
})

test('executeJobOnce re-resolves the org binding at run time instead of trusting the stored one', async () => {
	silenceIncidentalRuntimeWarnings()
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const executeSpy = vi.spyOn(registry, 'runBundledModuleWithRegistry')
	const callerContext = createBaseCallerContext()
	if (!callerContext.request) throw new Error('Expected a request context.')
	const orgId = 'org-gone'
	// Blobs persisted before this change still carry a binding and role.
	const legacyBlob = (orgBinding: unknown) =>
		({ ...callerContext, orgBinding }) as PersistedJobCallerContext
	const job = (id: string, owner: string) =>
		createJob({
			id,
			name: id,
			sourceId: `source-${id}`,
			schedule: { type: 'interval', every: '1h' },
			userId: ownerIdFromStored(owner),
		})

	// The stored blob still names the org, but the org was soft-deleted.
	const { env } = createExecuteEnv({
		orgs: [{ id: orgId, slug: 'gone', plan: 'free', deleted_at: '2026-01-01' }],
	})
	const missingOrg = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'job-org-gone' },
		env,
		job: job('job-org-gone', orgId),
		callerContext: legacyBlob({
			org: { id: orgId, slug: 'gone' },
			role: 'owner',
		}),
	})
	expect(missingOrg.execution).toMatchObject({
		ok: false,
		error: expect.stringContaining('no longer active'),
	})

	// Run-now by a person who no longer holds the org fails closed.
	const { env: orgEnv } = createExecuteEnv({
		orgs: [{ id: 'org-live', slug: 'live', plan: 'free' }],
	})
	const lostAccess = await executeJobOnce({
		source: inheritRequest(callerContext.request),
		env: orgEnv,
		job: job('job-lost-access', 'org-live'),
		callerContext: legacyBlob({
			org: { id: 'org-live', slug: 'live' },
			role: 'owner',
		}),
	})
	expect(lostAccess.execution).toMatchObject({
		ok: false,
		error: expect.stringContaining('no longer has access'),
	})

	expect(executeSpy).not.toHaveBeenCalled()
	expect(recordUsageSpy).not.toHaveBeenCalled()
})

test("a team-org job runs for an active member and a run-now uses the member's current role", async () => {
	silenceIncidentalRuntimeWarnings()
	vi.spyOn(usageModule, 'recordUsage').mockResolvedValue(undefined)
	const base = createBaseCallerContext()
	const teamOrgId = ownerIdFromStored('org-team')
	const { db, env } = createExecuteEnv({
		orgs: [{ id: teamOrgId, slug: 'team', plan: 'free' }],
		org_memberships: [
			{ org_id: teamOrgId, user_id: base.user.userId, role: 'member' },
		],
	})
	// The request is bound to the team org; the stored blob (pre-change) still
	// carries the Owner role the member held when the job was created.
	const teamContext = withCallerUser(
		createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: base.baseUrl,
			user: base.user,
			storageContext: base.storageContext,
			orgBinding: { org: { id: teamOrgId, slug: 'team' }, role: 'owner' },
		}),
	)
	if (!teamContext.request) throw new Error('Expected a request context.')
	mockRepoPersistence()
	const jobView = await insertPackageJob({
		env,
		callerContext: teamContext,
		ownerId: teamOrgId,
		body: { name: 'team-job', schedule: { type: 'interval', every: '1h' } },
	})
	const row = await getJobRowById(db, teamOrgId, jobView.id)
	if (!row) throw new Error('Expected the job under the team org.')

	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({ result: { ok: true }, error: undefined, logs: [] })
	const legacyBlob = {
		...row.callerContext,
		orgBinding: { org: { id: teamOrgId, slug: 'team' }, role: 'owner' },
	} as PersistedJobCallerContext

	// Scheduled tick: team automation with no actor keeps running.
	const scheduled = await executeJobOnce({
		source: { kind: 'schedule', jobId: row.record.id },
		env,
		job: row.record,
		callerContext: legacyBlob,
	})
	expect(scheduled.execution).toMatchObject({ ok: true })
	expect(executeSpy).toHaveBeenCalledTimes(1)
	expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({
		orgBinding: { org: { id: teamOrgId }, role: null },
	})

	// Run-now by the (now demoted) member runs with the role they hold today.
	const runNow = await executeJobOnce({
		source: inheritRequest(teamContext.request),
		env,
		job: row.record,
		callerContext: legacyBlob,
	})
	expect(runNow.execution).toMatchObject({ ok: true })
	expect(executeSpy).toHaveBeenCalledTimes(2)
	expect(executeSpy.mock.calls[1]?.[1]).toMatchObject({
		orgBinding: { org: { id: teamOrgId }, role: 'member' },
	})

	// A member's update targets the team's job, not a personal one.
	await updateJob({
		env,
		callerContext: teamContext,
		body: { id: jobView.id, enabled: false },
	})
	const updated = await getJobRowById(db, teamOrgId, jobView.id)
	expect(updated?.record.enabled).toBe(false)
})
