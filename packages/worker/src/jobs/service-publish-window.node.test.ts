import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import * as registry from '#mcp/run-kody-registry.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	persistPublishedBundleArtifact,
	rebuildPublishedPackageArtifacts,
} from '#worker/package-runtime/published-bundle-artifacts.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	getEntitySourceById,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	createBaseCallerContext,
	createBundleArtifactsKv,
	createDatabase,
	createJobServiceTestEnv,
	createPackageJobManifest,
	createStorageRunnerBinding,
	insertPublishedEntitySource,
	resetJobServiceMocks,
} from '#worker/test-support/jobs-service.ts'
import { TransientJobExecutionError } from './execution-safety.ts'
import { buildPackageJobId } from './package-job-id.ts'
import { executeJobOnce } from './service.ts'
import type { JobRecord } from './types.ts'

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

const userId = ownerIdFromStored('user-123')
const sourceId = 'source-publish-window-job'
const packageId = 'pkg-publish-window-job'
const kodyId = 'publish-window-job'
const jobName = 'publish-window-job'
const manifest = {
	...createPackageJobManifest({
		packageName: '@kody/publish-window-job',
		kodyId,
		description: 'Runs while a publish is building',
		jobName,
		exportPath: './src/job.ts',
	}),
	// Declared but not installed in the snapshot: only publish can bundle it.
	dependencies: { 'tiny-npm-dependency': '1.0.0' },
}
const packageContext = { packageId, kodyId, sourceId }

function packageFiles(commit: string) {
	return {
		'package.json': JSON.stringify(manifest),
		'src/job.ts': `export default async () => ({ commit: "${commit}" })`,
	}
}

function bundleFor(commit: string) {
	return {
		mainModule: 'dist/bundled-entry.js',
		modules: {
			'dist/bundled-entry.js': `export default async () => ({ bundle: "bundle-${commit}" })`,
		},
		dependencies: [],
	}
}

async function setUpPublishedJob(input: { withCompleteBundle: boolean }) {
	silenceIncidentalRuntimeWarnings()
	const { db, bundleKv, env } = createExecuteEnv()
	await insertPublishedEntitySource({
		db,
		userId,
		sourceId,
		entityKind: 'package',
		entityId: packageId,
		publishedCommit: 'commit-1',
		kv: bundleKv,
		files: packageFiles('commit-1'),
	})
	const artifactEnv = { APP_DB: db, BUNDLE_ARTIFACTS_KV: bundleKv } as Env
	if (input.withCompleteBundle) {
		const source = await getEntitySourceById(db, sourceId)
		if (!source) throw new Error('Expected source row.')
		await persistPublishedBundleArtifact({
			env: artifactEnv,
			userId,
			source,
			kind: 'job',
			artifactName: jobName,
			entryPoint: 'src/job.ts',
			...bundleFor('commit-1'),
			packageContext,
		})
	}
	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({ result: { ok: true }, logs: [] })
	const runJob = (
		runRecordHandle?: Parameters<typeof executeJobOnce>[0]['runRecordHandle'],
	) =>
		executeJobOnce({
			source: { kind: 'schedule', jobId: jobName },
			env,
			job: createJob({
				id: buildPackageJobId(packageId, jobName),
				name: jobName,
				sourceId,
			}),
			callerContext: createBaseCallerContext(),
			runRecordHandle,
		})
	const executedBundle = () =>
		Object.values(executeSpy.mock.calls.at(-1)?.[2]?.modules ?? {}).join('\n')

	/** Finalize moves `published_commit` before publish builds the targets. */
	async function publishCommit(commit: string) {
		await updateEntitySource(db, {
			id: sourceId,
			userId,
			publishedCommit: commit,
		})
		const source = await getEntitySourceById(db, sourceId)
		if (!source) throw new Error('Expected source row.')
		await writePublishedSourceSnapshot({
			env: artifactEnv,
			source,
			files: packageFiles(commit),
		})
		return {
			rebuildArtifacts: (
				buildBundle: () => Promise<ReturnType<typeof bundleFor>>,
			) =>
				rebuildPublishedPackageArtifacts({
					env: artifactEnv,
					userId,
					source,
					savedPackage: {
						id: packageId,
						kodyId,
						sourceId,
					} as SavedPackageRecord,
					manifest: parseAuthoredPackageJson({
						content: JSON.stringify(manifest),
					}),
					buildAppBundle: buildBundle,
					buildAppClientBundle: buildBundle,
					buildModuleBundle: buildBundle,
					buildImportableModuleBundle: buildBundle,
				}),
		}
	}
	return { runJob, executeSpy, executedBundle, publishCommit }
}

test('a job run while a publish is building keeps the previous bundle', async () => {
	const { runJob, executedBundle, publishCommit } = await setUpPublishedJob({
		withCompleteBundle: true,
	})
	await publishCommit('commit-2')

	const outcome = await runJob()

	expect(outcome.execution).toMatchObject({ ok: true })
	expect(executedBundle()).toContain('bundle-commit-1')
})

test('a failed publish rebuild keeps the previous bundle serving', async () => {
	const { runJob, executedBundle, publishCommit } = await setUpPublishedJob({
		withCompleteBundle: true,
	})
	const publish = await publishCommit('commit-2')

	await expect(
		publish.rebuildArtifacts(async () => {
			throw new Error('esbuild failed')
		}),
	).rejects.toThrow('esbuild failed')
	const outcome = await runJob()

	expect(outcome.execution).toMatchObject({ ok: true })
	expect(executedBundle()).toContain('bundle-commit-1')
})

test('a finished publish rebuild switches jobs to the new bundle', async () => {
	const { runJob, executedBundle, publishCommit } = await setUpPublishedJob({
		withCompleteBundle: true,
	})
	const publish = await publishCommit('commit-2')
	await publish.rebuildArtifacts(async () => bundleFor('commit-2'))

	const outcome = await runJob()

	expect(outcome.execution).toMatchObject({ ok: true })
	expect(executedBundle()).toContain('bundle-commit-2')
	expect(executedBundle()).not.toContain('bundle-commit-1')
})

test('a scheduled run retries while a first publish is still building its bundle', async () => {
	const { runJob, executeSpy } = await setUpPublishedJob({
		withCompleteBundle: false,
	})
	const claimedHandle = {
		id: 'run-claimed-publish-window',
		userId,
		startedAt: new Date().toISOString(),
		persistence: 'eager' as const,
		context: {
			surface: 'job' as const,
			name: jobName,
			jobId: buildPackageJobId(packageId, jobName),
			storageId: `job:${jobName}`,
		},
	}

	await expect(runJob(claimedHandle)).rejects.toBeInstanceOf(
		TransientJobExecutionError,
	)
	// Run now has no retry loop: it reports the missing bundle instead.
	const runNow = await runJob()
	expect(runNow.execution).toMatchObject({
		ok: false,
		error: expect.stringContaining(
			'no published runtime bundle artifact is available yet',
		),
	})
	// Long after the publish, the build failed: the scheduled run fails too.
	vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1_000)
	const stale = await runJob(claimedHandle)
	expect(stale.execution).toMatchObject({ ok: false })
	expect(executeSpy).not.toHaveBeenCalled()
})
