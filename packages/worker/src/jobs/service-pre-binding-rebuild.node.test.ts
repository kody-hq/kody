import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import * as registry from '#mcp/run-kody-registry.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	createBaseCallerContext,
	createBundleArtifactsKv,
	createDatabase,
	createJobServiceTestEnv,
	createPackageJobManifestText,
	createStorageRunnerBinding,
	insertPublishedEntitySource,
	resetJobServiceMocks,
} from '#worker/test-support/jobs-service.ts'
import { buildPackageJobId } from './package-job-id.ts'
import { executeJobOnce } from './service.ts'
import { type JobRecord } from './types.ts'

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

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- restores the shared job-service mocks and spies between tests.
afterEach(() => {
	resetJobServiceMocks()
})

const recurringSchedule = { type: 'interval', every: '1h' } as const

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
		schedule: recurringSchedule,
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

test('pre-binding job bundles that inline another package rebuild before a scheduled run', async () => {
	silenceIncidentalRuntimeWarnings()
	const { db, bundleKv, env } = createExecuteEnv()
	await insertPublishedEntitySource({
		db,
		userId: ownerIdFromStored('user-123'),
		sourceId: 'source-pre-binding-job',
		entityKind: 'package',
		entityId: 'pkg-pre-binding-job',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		kv: bundleKv,
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/pre-binding-job',
				kodyId: 'pre-binding-job',
				description: 'Runs pre-binding bundle test',
				jobName: 'pre-binding-job',
				exportPath: './src/job.ts',
			}),
			'src/job.ts': 'export default async () => ({ version: "source" })',
		},
	})
	const source = await getEntitySourceById(db, 'source-pre-binding-job')
	if (!source) throw new Error('Expected source row.')
	// A job bundle stored before GHSA-5fv3 at the current commit: it inlines
	// another package and calls a free fetch with no package binding.
	const kvKey = await persistPublishedBundleArtifact({
		env: { APP_DB: db, BUNDLE_ARTIFACTS_KV: bundleKv } as Env,
		userId: ownerIdFromStored('user-123'),
		source,
		kind: 'job',
		artifactName: 'pre-binding-job',
		entryPoint: 'src/job.ts',
		mainModule: 'dist/bundled-entry.js',
		modules: {
			'dist/bundled-entry.js':
				'export default async () => { await fetch("https://example.com/"); return { version: "pre-binding-bundle" } }',
		},
		dependencies: [
			{
				sourceId: 'source-dependency',
				publishedCommit: 'dependency-commit',
				kodyId: 'dependency',
				packageId: 'pkg-dependency',
			},
		],
		packageContext: {
			packageId: 'pkg-pre-binding-job',
			kodyId: 'pre-binding-job',
			sourceId: 'source-pre-binding-job',
		},
	})
	if (!kvKey) throw new Error('Expected stored job bundle.')
	const stored = (await bundleKv.get(kvKey, 'json')) as Record<string, unknown>
	delete stored.packageBindingRewrite
	await bundleKv.put(kvKey, JSON.stringify(stored))
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({ result: { ok: true }, logs: [] })

	const outcome = await executeJobOnce({
		source: { kind: 'schedule', jobId: 'test-job' },
		env,
		job: createJob({
			id: buildPackageJobId('pkg-pre-binding-job', 'pre-binding-job'),
			name: 'pre-binding-job',
			sourceId: 'source-pre-binding-job',
			publishedCommit: 'commit-1',
		}),
		callerContext: createBaseCallerContext(),
	})

	expect(outcome.execution).toMatchObject({ ok: true })
	expect(executeSpy).toHaveBeenCalledTimes(1)
	const executedModules = Object.values(
		executeSpy.mock.calls[0]?.[2]?.modules ?? {},
	).join('\n')
	expect(executedModules).toContain('userEntrypoint')
	expect(executedModules).not.toContain('pre-binding-bundle')
})
