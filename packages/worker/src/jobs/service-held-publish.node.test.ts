import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { listJobRowsByUserId } from '@kody-internal/shared/jobs/repo.ts'
import { afterEach, expect, test, vi } from 'vitest'
import * as registry from '#mcp/run-kody-registry.ts'
import { persistPublishedBundleArtifact } from '#worker/package-runtime/published-bundle-artifacts.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	advanceEntitySourceServingCommit,
	getEntitySourceById,
	holdEntitySourceCommit,
	updateEntitySource,
} from '#worker/repo/entity-sources.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import {
	createBaseCallerContext,
	createBundleArtifactsKv,
	createDatabase,
	createJobServiceTestEnv,
	createStorageRunnerBinding,
	insertPublishedEntitySource,
	resetJobServiceMocks,
} from '#worker/test-support/jobs-service.ts'
import { ensureOwnerCronEnablementForJob } from '#worker/enablements/owner-cron-enablement.ts'
import { executeJobOnce, syncPublishedPackageJobs } from './service.ts'

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

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- restores the shared job-service mocks and spies between tests.
afterEach(() => {
	resetJobServiceMocks()
})

const userId = ownerIdFromStored('user-123')
const sourceId = 'source-held-newsletter'
const packageId = 'pkg-held-newsletter'
const kodyId = 'held-newsletter'
const hourly = { type: 'interval', every: '1h' } as const
const approverId = personIdFromStored('person-approver')

/**
 * commit-1 sends the newsletter and a digest. commit-2 (held: it asks for
 * wider capabilities) rewrites the send, drops the digest, and adds a blast.
 */
const jobsByCommit: Record<string, Array<string>> = {
	'commit-1': ['send-newsletter', 'digest'],
	'commit-2': ['send-newsletter', 'blast'],
}

function packageFiles(commit: string) {
	const jobs = jobsByCommit[commit] ?? []
	return {
		'package.json': JSON.stringify({
			name: `@kody/${kodyId}`,
			exports: { '.': './src/index.ts' },
			// Declared but not installed: only publish can bundle these jobs.
			dependencies: { 'tiny-npm-dependency': '1.0.0' },
			kody: {
				id: kodyId,
				description: 'Sends a newsletter',
				jobs: Object.fromEntries(
					jobs.map((name) => [
						name,
						{ entry: `./src/jobs/${name}.ts`, schedule: hourly },
					]),
				),
			},
		}),
		'src/index.ts': 'export {}',
		...Object.fromEntries(
			jobs.map((name) => [
				`src/jobs/${name}.ts`,
				`export default async () => ({ job: "${name}", commit: "${commit}" })`,
			]),
		),
	}
}

async function setUp() {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
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

	/** What a publish does once the commit's build is saved. */
	async function build(commit: string) {
		const source = await getEntitySourceById(db, sourceId)
		if (!source) throw new Error('Expected source row.')
		for (const name of jobsByCommit[commit] ?? []) {
			await persistPublishedBundleArtifact({
				env,
				userId,
				source,
				kind: 'job',
				artifactName: name,
				entryPoint: `src/jobs/${name}.ts`,
				mainModule: 'dist/bundled-entry.js',
				modules: {
					'dist/bundled-entry.js': `export default async () => ({ bundle: "${name}@${commit}" })`,
				},
				dependencies: [],
				packageContext: { packageId, kodyId, sourceId },
			})
		}
	}

	/** The projection's job step: the serving commit, or one about to serve. */
	async function syncJobs(commit?: string) {
		await syncPublishedPackageJobs({
			env,
			userId,
			baseUrl: 'https://heykody.dev',
			packageId,
			sourceId,
			...(commit ? { commit, actorUserId: approverId } : {}),
		})
	}

	/** Finalize moves `published_commit` and projects it before the build. */
	async function publish(commit: string) {
		await updateEntitySource(db, {
			id: sourceId,
			userId,
			publishedCommit: commit,
		})
		const source = await getEntitySourceById(db, sourceId)
		if (!source) throw new Error('Expected source row.')
		await writePublishedSourceSnapshot({
			env,
			source,
			files: packageFiles(commit),
		})
		await syncJobs()
		await build(commit)
	}

	const jobs = async () =>
		Object.fromEntries(
			(await listJobRowsByUserId(db, userId)).map((row) => [
				row.record.name,
				row.record.publishedCommit,
			]),
		)
	const jobRows = async () =>
		(await listJobRowsByUserId(db, userId)).map(({ record }) => ({
			name: record.name,
			enabled: record.enabled,
			schedule: record.schedule,
			nextRunAt: record.nextRunAt,
			publishedCommit: record.publishedCommit,
		}))

	const executeSpy = vi
		.spyOn(registry, 'runBundledModuleWithRegistry')
		.mockResolvedValue({ result: { ok: true }, logs: [] })
	async function run(name: string) {
		const row = (await listJobRowsByUserId(db, userId)).find(
			(entry) => entry.record.name === name,
		)
		if (!row) throw new Error(`Expected job "${name}" to be registered.`)
		const outcome = await executeJobOnce({
			source: { kind: 'schedule', jobId: name },
			env,
			job: row.record,
			callerContext: createBaseCallerContext(),
		})
		expect(outcome.execution).toMatchObject({ ok: true })
		return Object.values(executeSpy.mock.calls.at(-1)?.[2]?.modules ?? {}).join(
			'\n',
		)
	}

	await syncJobs()
	await build('commit-1')
	await advanceEntitySourceServingCommit(db, {
		id: sourceId,
		userId,
		commit: 'commit-1',
	})
	return { db, jobs, jobRows, publish, syncJobs, run }
}

test('a held publish never touches jobs, and approval switches them with the code', async () => {
	const site = await setUp()
	const before = await site.jobRows()
	expect(await site.jobs()).toEqual({
		'send-newsletter': 'commit-1',
		digest: 'commit-1',
	})

	await site.publish('commit-2')
	// The build asks for wider capabilities: it is held.
	await expect(
		holdEntitySourceCommit(site.db, {
			id: sourceId,
			userId,
			commit: 'commit-2',
		}),
	).resolves.toBe(true)
	await site.syncJobs()

	// No row changed: the removed digest keeps running with its own enabled
	// state and enabler, and the added blast is not registered.
	expect(await site.jobRows()).toEqual(before)
	expect(await site.run('digest')).toContain('digest@commit-1')
	// The email-sending job never runs the held code.
	const sent = await site.run('send-newsletter')
	expect(sent).toContain('send-newsletter@commit-1')
	expect(sent).not.toContain('commit-2')

	// Approval syncs the jobs to commit-2, then moves the code.
	vi.mocked(ensureOwnerCronEnablementForJob).mockClear()
	await site.syncJobs('commit-2')
	await advanceEntitySourceServingCommit(site.db, {
		id: sourceId,
		userId,
		commit: 'commit-2',
	})
	expect(await site.jobs()).toEqual({
		'send-newsletter': 'commit-2',
		blast: 'commit-2',
	})
	// The added job is enabled as the approver, not the earliest Owner.
	expect(ensureOwnerCronEnablementForJob).toHaveBeenCalledWith(
		expect.objectContaining({ jobName: 'blast', enablerUserId: approverId }),
	)
	expect(await site.run('send-newsletter')).toContain(
		'send-newsletter@commit-2',
	)
	expect(await site.run('blast')).toContain('blast@commit-2')
})
