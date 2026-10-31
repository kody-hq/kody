// RepoSession publish paths keep heavy publish work off the coordinating
// Durable Object (kody-hq/kody#4078): every heavy step runs on a throwaway
// isolate. Mock setup mirrors repo-session-do.node.test.ts.

import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type Workspace } from '@cloudflare/shell'
import type git from 'isomorphic-git'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as Checks from './checks.ts'
import type * as EntitySources from './entity-sources.ts'
import type * as ExternalPublishClone from './external-publish-clone.ts'
import type * as PublishGitNotes from './publish-git-notes.ts'
import type * as RepoSessions from './repo-sessions.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import type * as SavedPackageRepo from '#worker/package-registry/repo.ts'
import type * as CredentialNeedsApproval from '#worker/credentials/credential-needs-approval.ts'
import type * as StorageBuckets from '#worker/storage-buckets/service.ts'
import {
	repoSessionMockModule as mockModule,
	publishedBundleArtifactsRepoSessionMocks,
	checkedPublishState,
	createDurableObjectState,
	createExternalClone,
	createFakeRepoSessionBlobs,
	setCommonSessionFixtures,
	workspaceTreeHash,
} from '#worker/test-support/repo-session-do.ts'

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		DurableObject: class {
			protected readonly ctx: DurableObjectState
			protected readonly env: Env

			constructor(ctx: DurableObjectState, env: Env) {
				this.ctx = ctx
				this.env = env
			}
		},
	}
})

vi.mock('@cloudflare/shell', () => ({
	Workspace: class {
		constructor(_options: unknown) {}
		exists(path: string) {
			return mockModule.workspaceExists(path)
		}
		stat(path: string) {
			return mockModule.workspaceStat(path)
		}
		readFile(path: string) {
			return mockModule.workspaceReadFile(path)
		}
		readFileBytes(path: string) {
			return mockModule.workspaceReadFileBytes(path)
		}
		writeFile(path: string, content: string) {
			return mockModule.workspaceWriteFile(path, content)
		}
		writeFileBytes(path: string, content: Uint8Array) {
			return mockModule.workspaceWriteFileBytes(path, content)
		}
		mkdir(...args: Parameters<Workspace['mkdir']>) {
			return mockModule.workspaceMkdir(...args)
		}
		rm(...args: Parameters<Workspace['rm']>) {
			return mockModule.workspaceRm(...args)
		}
		glob(pattern: string) {
			return mockModule.workspaceGlob(pattern)
		}
	},
	WorkspaceFileSystem: class {
		constructor(_workspace: unknown) {}
	},
	createWorkspaceStateBackend: vi.fn(() => ({
		// applyEditPlan persists caller-planned contents. Sequential same-path
		// composition is planned in Kody before this backend sees the batch.
		planEdits: vi.fn(
			async (
				instructions: Array<{ kind: string; path: string; content?: string }>,
			) => ({
				edits: instructions.map((instruction) => ({
					instruction,
					path: instruction.path,
					changed: true,
					content: instruction.content ?? '',
					diff: '',
				})),
				totalChanged: instructions.length,
				totalInstructions: instructions.length,
			}),
		),
		applyEditPlan: vi.fn(
			async (plan: {
				edits: Array<{ path: string; content: string; diff: string }>
				totalChanged: number
			}) => ({
				dryRun: false,
				totalChanged: plan.totalChanged,
				edits: plan.edits.map((edit) => ({
					path: edit.path,
					changed: true,
					content: edit.content,
					diff: edit.diff,
				})),
			}),
		),
		walkTree: vi.fn(),
	})),
}))

vi.mock('@cloudflare/shell/git', () => ({
	createGit: vi.fn(() => mockModule.git),
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: {
			push: (...args: Parameters<typeof git.push>) =>
				mockModule.rawPush(...args),
			commit: (...args: Parameters<typeof git.commit>) =>
				mockModule.rawCommit(...args),
			readBlob: mockModule.readBlob,
			pull: (...args: Parameters<typeof git.pull>) =>
				mockModule.rawPull(...args),
			resolveRef: (...args: Parameters<typeof git.resolveRef>) =>
				mockModule.rawResolveRef(...args),
			writeRef: (...args: Parameters<typeof git.writeRef>) =>
				mockModule.rawWriteRef(...args),
		},
		http: {},
		createGit: () => mockModule.git,
	}),
}))

const publishNotes = vi.hoisted(() => ({
	attach: vi.fn(async () => undefined),
	read: vi.fn(),
}))

vi.mock('./publish-git-notes.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PublishGitNotes>()),
	attachPublishGitNoteBestEffort: publishNotes.attach,
	readPublishGitNoteFromArtifactsRepo: publishNotes.read,
}))

vi.mock('./repo-sessions.ts', () => ({
	getRepoSessionById: (
		...args: Parameters<typeof RepoSessions.getRepoSessionById>
	) => mockModule.getRepoSessionById(...args),
	insertRepoSession: vi.fn(async () => undefined),
	updateRepoSession: (
		...args: Parameters<typeof RepoSessions.updateRepoSession>
	) => mockModule.updateRepoSession(...args),
	deleteRepoSession: vi.fn(async () => undefined),
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (
		...args: Parameters<typeof EntitySources.getEntitySourceById>
	) => mockModule.getEntitySourceById(...args),
	updateEntitySource: (
		...args: Parameters<typeof EntitySources.updateEntitySource>
	) => mockModule.updateEntitySource(...args),
	markEntitySourcePendingExternalReconcile: (
		...args: Parameters<
			typeof EntitySources.markEntitySourcePendingExternalReconcile
		>
	) => mockModule.markEntitySourcePendingExternalReconcile(...args),
}))

vi.mock('./artifacts.ts', async () => {
	const actual = await vi.importActual<typeof Artifacts>('./artifacts.ts')
	return {
		...actual,
		resolveArtifactSourceRepo: (
			...args: Parameters<typeof Artifacts.resolveArtifactSourceRepo>
		) => mockModule.resolveArtifactSourceRepo(...args),
		resolveExistingArtifactSourceRepo: (
			...args: Parameters<typeof Artifacts.resolveExistingArtifactSourceRepo>
		) => mockModule.resolveExistingArtifactSourceRepo(...args),
		resolveArtifactDefaultBranchHead: (
			...args: Parameters<typeof Artifacts.resolveArtifactDefaultBranchHead>
		) => mockModule.resolveArtifactDefaultBranchHead(...args),
		resolveArtifactSourceHead: (
			...args: Parameters<typeof Artifacts.resolveArtifactSourceHead>
		) => mockModule.resolveArtifactSourceHead(...args),
		listArtifactServerRefs: (
			...args: Parameters<typeof Artifacts.listArtifactServerRefs>
		) => mockModule.listArtifactServerRefs(...args),
	}
})

vi.mock('./checks.ts', () => ({
	runRepoChecks: (...args: Parameters<typeof Checks.runRepoChecks>) =>
		mockModule.runRepoChecks(...args),
	validatePackageBundles: (
		...args: Parameters<typeof Checks.validatePackageBundles>
	) => mockModule.validatePackageBundles(...args),
	runPackageTypecheckLanguageService: (
		...args: Parameters<typeof Checks.runPackageTypecheckLanguageService>
	) => mockModule.runPackageTypecheckLanguageService(...args),
	formatFailedRepoCheckMessages: (
		results: Array<{ ok: boolean; message: string }>,
		fallback = 'Publish checks failed.',
	) => {
		const failed = results
			.filter((entry) => !entry.ok)
			.map((entry) => entry.message)
			.filter((message) => message.trim().length > 0)
		return failed.length > 0 ? failed.join('\n') : fallback
	},
	createSnapshotFilesWorkspace: (files: Record<string, string>) => ({
		async readFile(path: string) {
			return files[path.trim().replace(/^\/+/, '')] ?? null
		},
		async glob() {
			return Object.keys(files).map((path) => ({
				path,
				type: 'file' as const,
			}))
		},
	}),
}))

vi.mock('./external-publish-clone.ts', () => ({
	externalPublishWorkspaceDir: '/repo',
	isWorkspaceSqliteTooBigMessage: (message: string) =>
		message.includes('SQLITE_TOOBIG') ||
		/string or blob too big/i.test(message),
	buildWorkspaceSqliteTooBigCallerMessage: (operation: string) =>
		`${operation} failed because a git object exceeded the Durable Object SQLite 2 MiB row limit`,
	cloneExternalPublishWorkspace: (
		...args: Parameters<
			typeof ExternalPublishClone.cloneExternalPublishWorkspace
		>
	) => mockModule.cloneExternalPublishWorkspace(...args),
}))

const skillSnapshot = vi.hoisted(() => vi.fn())

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedRuntimeArtifacts>(
		'#worker/package-runtime/published-runtime-artifacts.ts',
	)
	return {
		...actual,
		readPublishedSourceSnapshot: skillSnapshot,
		writePublishedSourceSnapshot: (
			...args: Parameters<
				typeof PublishedRuntimeArtifacts.writePublishedSourceSnapshot
			>
		) => mockModule.writePublishedSourceSnapshot(...args),
		loadPublishedSourceSnapshot: (
			...args: Parameters<
				typeof PublishedRuntimeArtifacts.loadPublishedSourceSnapshot
			>
		) => mockModule.loadPublishedSourceSnapshot(...args),
		loadPublishedSourceManifestSnapshot: (
			...args: Parameters<
				typeof PublishedRuntimeArtifacts.loadPublishedSourceManifestSnapshot
			>
		) => mockModule.loadPublishedSourceManifestSnapshot(...args),
	}
})

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'#worker/package-runtime/published-bundle-artifacts.ts',
	)
	return {
		...actual,
		...publishedBundleArtifactsRepoSessionMocks(mockModule),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (
		...args: Parameters<typeof SavedPackageRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-runtime/package-app-authority.ts')
vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: vi.fn(async () => undefined),
}))

const needsGate = vi.hoisted(() => ({
	requireCredentialNeedsApproval: vi.fn(
		async (): Promise<CredentialNeedsApproval.CredentialNeedsApprovalRequired | null> =>
			null,
	),
}))

vi.mock(
	'#worker/credentials/credential-needs-approval.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof CredentialNeedsApproval>()),
		requireCredentialNeedsApproval: needsGate.requireCredentialNeedsApproval,
	}),
)

vi.mock('#worker/repo/identity-icon.ts', () => ({
	refreshIdentityIconForSource: vi.fn(async () => undefined),
}))

vi.mock('#worker/community/community-icon.ts', () => ({
	refreshCommunityIconForPackagePublish: vi.fn(async () => undefined),
}))

vi.mock('#worker/storage-buckets/service.ts', () => ({
	deleteStorageBucketInventory: (
		...args: Parameters<typeof StorageBuckets.deleteStorageBucketInventory>
	) => mockModule.deleteStorageBucketInventory(...args),
	maybeRefreshStorageBucketEstimate: (
		...args: Parameters<typeof StorageBuckets.maybeRefreshStorageBucketEstimate>
	) => mockModule.maybeRefreshStorageBucketEstimate(...args),
	registerStorageBucketAndWait: (
		...args: Parameters<typeof StorageBuckets.registerStorageBucketAndWait>
	) => mockModule.registerStorageBucketAndWait(...args),
	storageBucketInventoryExists: (
		...args: Parameters<typeof StorageBuckets.storageBucketInventoryExists>
	) => mockModule.storageBucketInventoryExists(...args),
	repoSessionStorageBucketId: (sessionId: string) =>
		`repo-session:${sessionId}`,
}))

const offload = vi.hoisted(() => {
	const state = {
		depth: 0,
		heavyCalls: [] as Array<{ name: string; depth: number }>,
		record(name: string) {
			state.heavyCalls.push({ name, depth: state.depth })
		},
	}
	return state
})

vi.mock(
	'#worker/credentials/credential-stamp-store.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		storePublishedCredentialStamp: vi.fn(async () => {
			offload.record('credential-stamp')
			return { stamp: {}, files: {} }
		}),
	}),
)

vi.mock(
	'#worker/credentials/credential-needs-closure.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		storePublishedCredentialNeeds: vi.fn(async () => {
			offload.record('credential-needs')
		}),
	}),
)

vi.mock(
	'#worker/package-runtime/secret-mount-compat.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		loadSecretMountCompatNotice: vi.fn(async () => {
			offload.record('secret-mount-notice')
			return null
		}),
	}),
)

vi.mock(
	'#worker/credentials/credential-allowed-packages-publish-warning.ts',
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		loadCredentialAllowedPackagesPublishWarningNotice: vi.fn(async () => {
			offload.record('allowed-packages-notice')
			return null
		}),
	}),
)

const { RepoSession } = await import('./repo-session-do.ts')
const { refreshSavedPackageProjection } =
	await import('#worker/package-registry/service.ts')
const session = { sessionId: 'session-1', userId: ownerIdFromStored('user-1') }
const largePackageJson =
	'{"name":"@user/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"}}'

/** ~1.6 MB of source across 400 modules, the size class from KODY-CY. */
function largePackageFiles() {
	const files: Record<string, string> = {
		'package.json': largePackageJson,
		'src/index.ts': "export * from './module-0.ts'\n",
	}
	for (let index = 0; index < 400; index += 1) {
		files[`src/module-${index}.ts`] =
			`export const value${index} = '${'x'.repeat(4000)}'\n`
	}
	return files
}

function seedSessionWorkspace(files: Record<string, string>) {
	const relative = (path: string) => path.replace(/^\/session\//, '')
	mockModule.workspaceGlob.mockResolvedValue(
		Object.keys(files).map((path) => ({
			type: 'file',
			path: `/session/${path}`,
		})) as never,
	)
	mockModule.workspaceReadFile.mockImplementation(
		async (path: string) => files[relative(path)] ?? '',
	)
}

function createFakeKv() {
	const store = new Map<string, unknown>()
	return {
		store,
		get: vi.fn(async (key: string, type?: string) => {
			const value = store.get(key)
			if (value === undefined) return null
			if (type === 'json') {
				return typeof value === 'string' ? JSON.parse(value) : value
			}
			return value
		}),
		put: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
		list: vi.fn(async () => ({ keys: [], list_complete: true })),
	}
}

/**
 * Env whose `REPO_SESSION` hands out a fresh RepoSession per id, like the
 * platform. Records which step ran on which throwaway id, and the isolate
 * depth every heavy mock ran at (0 means the coordinating Durable Object).
 */
function createIsolateEnv(
	options: { failOnce?: { op: string; error: Error } } = {},
) {
	const kv = createFakeKv()
	const isolateRuns: Array<{ name: string; op: string }> = []
	let failOnce = options.failOnce
	const env = {
		APP_DB: {},
		REPO_SESSION_BLOBS: createFakeRepoSessionBlobs().bucket,
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as { REPO_SESSION?: unknown }
	const enter = async <T>(name: string, op: string, run: () => Promise<T>) => {
		isolateRuns.push({ name, op })
		if (failOnce && failOnce.op === op) {
			const { error } = failOnce
			failOnce = undefined
			throw error
		}
		offload.depth += 1
		try {
			return await run()
		} finally {
			offload.depth -= 1
		}
	}
	env.REPO_SESSION = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => {
			const instance = new RepoSession(
				createDurableObjectState(),
				env as unknown as Env,
			)
			return {
				runIsolatedPublishWork: (
					request: Parameters<RepoSessionInstance['runIsolatedPublishWork']>[0],
				) =>
					enter(id.name, request.op, () =>
						instance.runIsolatedPublishWork(request),
					),
				runIsolatedExternalRefClone: (
					request: Parameters<
						RepoSessionInstance['runIsolatedExternalRefClone']
					>[0],
				) =>
					enter(id.name, 'clone', () =>
						instance.runIsolatedExternalRefClone(request),
					),
				takeLastCheckStep: () => instance.takeLastCheckStep(),
			}
		},
	}
	return { env: env as unknown as Env, kv, isolateRuns }
}

type RepoSessionInstance = InstanceType<typeof RepoSession>

function repoSession(env: Env, state = createDurableObjectState()) {
	return new RepoSession(state, env)
}

function recordHeavyMocks() {
	offload.heavyCalls.length = 0
	offload.depth = 0
	const checksBaseline = mockModule.runRepoChecks.getMockImplementation()
	mockModule.runRepoChecks.mockImplementation(async (...args) => {
		offload.record('checks')
		return await checksBaseline!(...args)
	})
	mockModule.writePublishedSourceSnapshot.mockImplementation(async () => {
		offload.record('write-snapshot')
		return null as never
	})
	needsGate.requireCredentialNeedsApproval.mockImplementation(async () => {
		offload.record('approval')
		return null
	})
	vi.mocked(refreshSavedPackageProjection).mockImplementation(async () => {
		offload.record('projection')
		return undefined as never
	})
}

function expectAllHeavyWorkInIsolates(expected: Array<string>) {
	const names = offload.heavyCalls.map((call) => call.name)
	for (const name of expected) expect(names).toContain(name)
	expect(offload.heavyCalls.filter((call) => call.depth === 0)).toEqual([])
}

function expectStagingCleared(kv: ReturnType<typeof createFakeKv>) {
	expect(
		[...kv.store.keys()].filter((key) =>
			key.startsWith('repo-checks-staging:'),
		),
	).toEqual([])
}

function largestStagedChunkBytes(kv: ReturnType<typeof createFakeKv>) {
	return Math.max(
		0,
		...kv.put.mock.calls
			.filter(([key]) => String(key).includes(':chunk:'))
			.map(([, value]) => (value as ArrayBuffer).byteLength),
	)
}

test('publishSession on a large package runs every heavy step on its own throwaway isolate, never on the session Durable Object', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const files = largePackageFiles()
	seedSessionWorkspace(files)
	recordHeavyMocks()
	const state = await checkedPublishState(files)
	const { env, kv, isolateRuns } = createIsolateEnv()

	await expect(
		repoSession(env, state).publishSession(session),
	).resolves.toMatchObject({ status: 'ok' })

	expect(isolateRuns.map((run) => run.op)).toEqual([
		'notices',
		'approval',
		'write-snapshot',
		'store-credential-needs',
		'store-credential-stamp',
		'refresh-projection',
	])
	expect(new Set(isolateRuns.map((run) => run.name)).size).toBe(
		isolateRuns.length,
	)
	expectAllHeavyWorkInIsolates([
		'secret-mount-notice',
		'allowed-packages-notice',
		'approval',
		'write-snapshot',
		'credential-needs',
		'credential-stamp',
		'projection',
	])
	expect(largestStagedChunkBytes(kv)).toBeGreaterThan(1_500_000)
	expectStagingCleared(kv)
})

test('a publish step over the CPU limit names the compute limit, and the retry succeeds', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const files = largePackageFiles()
	seedSessionWorkspace(files)
	recordHeavyMocks()
	const state = await checkedPublishState(files)
	const { env, kv } = createIsolateEnv({
		failOnce: {
			op: 'store-credential-stamp',
			error: new Error(
				'Durable Object exceeded its CPU time limit and was reset.',
			),
		},
	})

	const error = await repoSession(env, state)
		.publishSession(session)
		.catch((caught: unknown) => caught as Error)
	expect(error).toBeInstanceOf(Error)
	// The message also lists the session tree's largest non-runtime files.
	expect((error as Error).message).toContain('exceeded a Kody compute limit')
	expect((error as Error).message).toContain('the credential stamp scan')
	expect((error as Error).message).toContain('`.kodyignore`')
	expectStagingCleared(kv)

	// The coordinating Durable Object survived; each step gets a fresh isolate
	// (and a fresh CPU budget) on the retry.
	await expect(
		repoSession(env, state).publishSession(session),
	).resolves.toMatchObject({ status: 'ok' })
	expectStagingCleared(kv)
})

test.each([
	{ retry: 'plain', retryInput: {}, noteFound: false },
	{ retry: 'plain (note already attached)', retryInput: {}, noteFound: true },
	{
		retry: 'forced',
		retryInput: { force: true, destructiveOverwriteConfirmed: true },
		noteFound: false,
	},
])(
	'a reset after published_commit moved leaves the publish unsealed, and a $retry retry at base == head finishes it',
	async ({ retryInput, noteFound }) => {
		consoleWarn.mockImplementation(() => {})
		setCommonSessionFixtures()
		const files = largePackageFiles()
		seedSessionWorkspace(files)
		recordHeavyMocks()
		const state = await checkedPublishState(files)
		const { env, kv, isolateRuns } = createIsolateEnv({
			failOnce: {
				op: 'refresh-projection',
				error: new Error('Durable Object reset because its code was updated.'),
			},
		})
		// The pointer write is durable; the reset kills the revert with it.
		const liveSource = await mockModule.getEntitySourceById()
		mockModule.updateEntitySource.mockImplementation(async (_db, update) => {
			if (update.publishedCommit === 'commit-base') throw new Error('reset')
			mockModule.getEntitySourceById.mockResolvedValue({
				...liveSource,
				published_commit: update.publishedCommit,
			})
			return undefined
		})
		const sealKeys = () =>
			[...kv.store.keys()].filter((key) => key.startsWith('publish-checks:'))

		await expect(
			repoSession(env, state).publishSession(session),
		).rejects.toThrow()
		expect(await mockModule.getEntitySourceById()).toMatchObject({
			published_commit: 'commit-head',
		})
		expect(sealKeys()).toEqual([])

		// Session base is still the old tip while the live tip is its HEAD: the
		// retry must finish the publish rather than report base_moved or no-op.
		isolateRuns.length = 0
		mockModule.rawCommit.mockClear()
		publishNotes.attach.mockClear()
		publishNotes.read.mockResolvedValue({ found: noteFound })
		// The live commit was a plain (parented) publish, so even a forced retry
		// must leave other sessions' advertised branches alone.
		const baselineLog = mockModule.git.log.getMockImplementation()
		mockModule.git.log.mockImplementation(async () => [
			{ oid: 'commit-head', parent: ['commit-base'] },
		])
		mockModule.listArtifactServerRefs.mockClear()
		// A forced publish first proves a restorable snapshot of the live tip.
		mockModule.loadPublishedSourceSnapshot.mockResolvedValue({
			files,
		} as never)
		await expect(
			repoSession(env, state).publishSession({ ...session, ...retryInput }),
		).resolves.toMatchObject({ status: 'ok', publishedCommit: 'commit-head' })
		// A forced retry must not mint a new parentless commit over the live one.
		expect(mockModule.rawCommit).not.toHaveBeenCalled()
		expect(mockModule.listArtifactServerRefs).not.toHaveBeenCalledWith(
			expect.objectContaining({ prefix: 'refs/heads/sessions/' }),
		)
		mockModule.git.log.mockImplementation(baselineLog!)
		// The note is owed only when the interrupted run never attached one.
		if (noteFound) expect(publishNotes.attach).not.toHaveBeenCalled()
		else
			expect(publishNotes.attach).toHaveBeenCalledWith(
				expect.objectContaining({ commitOid: 'commit-head' }),
			)
		expect(isolateRuns.map((run) => run.op)).toContain('refresh-projection')
		expect(sealKeys()).toEqual([expect.stringContaining(':commit-head')])
		expect(mockModule.updateRepoSession).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				status: 'published',
				baseCommit: 'commit-head',
			}),
		)
	},
)

test('repoRunChecks runs the publish checks on a throwaway isolate over the staged session tree', async () => {
	setCommonSessionFixtures()
	const files = largePackageFiles()
	seedSessionWorkspace(files)
	recordHeavyMocks()
	const { env, kv, isolateRuns } = createIsolateEnv()

	const result = await repoSession(env).runChecks(session)

	expect(result.ok).toBe(true)
	expect(result.treeHash).toBe(await workspaceTreeHash(files))
	expect(isolateRuns.map((run) => run.op)).toEqual(['checks'])
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ manifestPath: 'package.json', sourceRoot: '/' }),
	)
	expectAllHeavyWorkInIsolates(['checks'])
	expectStagingCleared(kv)
})

test('packagePublishExternalPush clones, checks, and finalizes a large package on throwaway isolates only', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	recordHeavyMocks()
	const files = largePackageFiles()
	const isAncestorCommit = vi.fn(async () => true)
	mockModule.cloneExternalPublishWorkspace.mockImplementation(async () => {
		offload.record('clone')
		return {
			...createExternalClone('commit-new'),
			collectFiles: vi.fn(async () => files),
			isAncestorCommit,
		} as never
	})
	mockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'source-repo',
		published_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
	} as never)
	const { env, kv, isolateRuns } = createIsolateEnv()

	const result = await repoSession(env).publishFromExternalRef({
		sessionId: 'external-publish-source-1',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		newCommit: 'commit-new',
		deferBundleCheckToRebuild: true,
	})

	expect(result).toMatchObject({
		status: 'published',
		phase_timings: expect.objectContaining({ clone_ms: expect.any(Number) }),
	})
	expect(isolateRuns.map((run) => run.op)).toEqual([
		'clone',
		'checks',
		'notices',
		'approval',
		'write-snapshot',
		'store-credential-needs',
		'store-credential-stamp',
		'refresh-projection',
	])
	expect(isAncestorCommit).toHaveBeenCalledWith({
		ancestor: 'commit-1',
		descendant: 'commit-new',
	})
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			manifestPath: 'package.json',
			sourceRoot: '/',
			deferBundleCheckToRebuild: true,
		}),
	)
	expectAllHeavyWorkInIsolates([
		'clone',
		'checks',
		'secret-mount-notice',
		'allowed-packages-notice',
		'approval',
		'write-snapshot',
		'credential-needs',
		'credential-stamp',
		'projection',
	])
	expect(largestStagedChunkBytes(kv)).toBeGreaterThan(1_500_000)
	expectStagingCleared(kv)

	// Approve-publish preview checks take the same path.
	isolateRuns.length = 0
	offload.heavyCalls.length = 0
	await expect(
		repoSession(env).checkExternalRef({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			commit: 'commit-new',
		}),
	).resolves.toMatchObject({ commit: 'commit-new', ok: true })
	expect(isolateRuns.map((run) => run.op)).toEqual(['clone', 'checks'])
	expectAllHeavyWorkInIsolates(['clone', 'checks'])
	expectStagingCleared(kv)
})

test('a publish whose HEAD left the session branch reattaches it before pushing, and last_publish records the result', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const files = largePackageFiles()
	seedSessionWorkspace(files)
	recordHeavyMocks()
	const state = await checkedPublishState(files)
	const { env } = createIsolateEnv()
	// An older repoRebaseSession pulled with `ref: main`, leaving HEAD on the
	// local source branch; the session branch tip is stale.
	mockModule.gitState.currentBranch = 'main'

	const repo = repoSession(env, state)
	await expect(repo.publishSession(session)).resolves.toMatchObject({
		status: 'ok',
		publishedCommit: 'commit-head',
	})
	expect(mockModule.rawWriteRef).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'refs/heads/sessions/session1',
			value: 'commit-head',
			force: true,
		}),
	)
	expect(mockModule.rawWriteRef).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'HEAD',
			value: 'refs/heads/sessions/session1',
			symbolic: true,
		}),
	)
	const branchWrite = mockModule.rawWriteRef.mock.invocationCallOrder[0]!
	expect(branchWrite).toBeLessThan(
		mockModule.rawPush.mock.invocationCallOrder[0]!,
	)
	expect((await repo.getSessionInfo(session)).last_publish).toMatchObject({
		state: 'published',
		published_commit: 'commit-head',
		result_status: 'ok',
		error_name: null,
	})
})

test('a push the remote never confirms publishes nothing, reports failed in last_publish, and a reset mid-publish reads as interrupted', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const files = largePackageFiles()
	seedSessionWorkspace(files)
	recordHeavyMocks()
	const state = await checkedPublishState(files)
	const { env } = createIsolateEnv()
	// The push "succeeds" but the source branch stays at the old tip.
	mockModule.rawPush.mockImplementation(async () => ({
		ok: true,
		error: null,
		refs: {},
	}))
	mockModule.listArtifactServerRefs.mockResolvedValue([
		{ ref: 'refs/heads/main', oid: 'commit-base' },
	])

	const repo = repoSession(env, state)
	await expect(repo.publishSession(session)).rejects.toMatchObject({
		name: 'RemoteRefNotConfirmedError',
	})
	expect(mockModule.updateEntitySource).not.toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ publishedCommit: 'commit-head' }),
	)
	expect((await repo.getSessionInfo(session)).last_publish).toMatchObject({
		state: 'failed',
		published_commit: null,
		error_name: 'RemoteRefNotConfirmedError',
		error_message: expect.stringContaining('Nothing was published'),
	})

	// A `running` record left by an instance that was reset mid-publish.
	await state.storage.put('repo-session:last-publish', {
		state: 'running',
		started_at: '2026-10-30T23:16:33.000Z',
		finished_at: null,
		published_commit: null,
		result_status: null,
		error_name: null,
		error_message: null,
	})
	expect(
		(await repoSession(env, state).getSessionInfo(session)).last_publish,
	).toMatchObject({ state: 'interrupted' })
})
