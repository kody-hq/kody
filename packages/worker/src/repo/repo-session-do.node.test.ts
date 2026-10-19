import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createWorkspaceStateBackend, type Workspace } from '@cloudflare/shell'
import type git from 'isomorphic-git'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as Checks from './checks.ts'
import type * as EntitySources from './entity-sources.ts'
import type * as ExternalPublishClone from './external-publish-clone.ts'
import type * as RepoSessions from './repo-sessions.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import {
	type PublishedSourceManifestSnapshot,
	type PublishedSourceSnapshot,
} from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import type * as SavedPackageRepo from '#worker/package-registry/repo.ts'
import type * as CredentialNeedsApproval from '#worker/credentials/credential-needs-approval.ts'
import type * as StorageBuckets from '#worker/storage-buckets/service.ts'
import {
	repoSessionMockModule as mockModule,
	restoreRepoSessionMockBaseline,
	checkedPublishState,
	createDurableObjectState,
	createExternalClone,
	createFakeRepoSessionBlobs,
	createEnv,
	sessionRow,
	stubPackageSourceForOpenSession,
	setCommonSessionFixtures,
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
		},
		http: {},
		createGit: () => mockModule.git,
	}),
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

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedRuntimeArtifacts>(
		'#worker/package-runtime/published-runtime-artifacts.ts',
	)
	return {
		...actual,
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
		isPublishedPackageArtifactBuiltForCommit: (
			...args: Parameters<
				typeof PublishedBundleArtifactsModule.isPublishedPackageArtifactBuiltForCommit
			>
		) => mockModule.isPublishedPackageArtifactBuiltForCommit(...args),
		persistPublishedPackageArtifactTarget: (
			...args: Parameters<
				typeof PublishedBundleArtifactsModule.persistPublishedPackageArtifactTarget
			>
		) => mockModule.persistPublishedPackageArtifactTarget(...args),
		deletePublishedArtifactsForSource: (
			...args: Parameters<
				typeof PublishedBundleArtifactsModule.deletePublishedArtifactsForSource
			>
		) => mockModule.deletePublishedArtifactsForSource(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (
		...args: Parameters<typeof SavedPackageRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
}))

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

const { RepoSession } = await import('./repo-session-do.ts')
const { deleteRepoSession, insertRepoSession } =
	await import('./repo-sessions.ts')
const { maxRepoSourceFileBytes, maxRepoSourceFileDiffLines } =
	await import('./large-file-policy.ts')

type RepoSessionInstance = InstanceType<typeof RepoSession>

const session = { sessionId: 'session-1', userId: ownerIdFromStored('user-1') }
const demoPackageJson =
	'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}'
const userPackageJson =
	'{"name":"@user/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"}}'
const artifactsRemote = (repo: string) =>
	`https://acct.artifacts.cloudflare.net/git/default/${repo}.git`

function repoSession(
	env: Env = createEnv(),
	state = createDurableObjectState(),
) {
	return new RepoSession(state, env)
}

function kvEnv(kv: unknown = {}) {
	return { APP_DB: {}, BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
}

function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-18T00:00:00.000Z',
		updated_at: '2026-04-18T00:00:00.000Z',
		...overrides,
	}
}

function publishedSnapshot(
	files: Record<string, string>,
	overrides: Partial<PublishedSourceSnapshot> = {},
): PublishedSourceSnapshot {
	return {
		version: 1,
		sourceId: 'source-1',
		repoId: 'package-package-1',
		entityKind: 'package',
		entityId: 'package-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files,
		createdAt: '2026-08-17T20:00:00.000Z',
		...overrides,
	}
}

/** Seeds `/session/<path>` workspace reads (and optionally glob/exists). */
function seedWorkspace(
	files: Record<string, string | null>,
	{
		fallback = '' as string | null,
		glob = true,
		exists = false,
	}: { fallback?: string | null; glob?: boolean; exists?: boolean } = {},
) {
	const relative = (path: string) => path.replace(/^\/session\//, '')
	if (glob) {
		mockModule.workspaceGlob.mockResolvedValue(
			Object.keys(files).map((path) => ({
				type: 'file',
				path: `/session/${path}`,
			})) as never,
		)
	}
	if (exists) {
		mockModule.workspaceExists.mockImplementation(
			async (path: string) => relative(path) in files,
		)
	}
	mockModule.workspaceReadFile.mockImplementation(async (path: string) =>
		relative(path) in files ? files[relative(path)]! : fallback,
	)
}

function preparePublish(
	headCommit: string,
	files: Record<string, string | null>,
	fallback: string | null = '',
) {
	setCommonSessionFixtures()
	mockModule.gitState.headCommit = headCommit
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	seedWorkspace(files, { fallback })
}

function publish(
	options: Partial<Parameters<RepoSessionInstance['publishSession']>[0]> = {},
	env: Env = kvEnv(),
	state = createDurableObjectState(),
) {
	return repoSession(env, state).publishSession({
		...session,
		force: true,
		...options,
	})
}

function publishExternal(
	options: Partial<
		Parameters<RepoSessionInstance['publishFromExternalRef']>[0]
	> = {},
	env: Env = kvEnv(),
) {
	return repoSession(env).publishFromExternalRef({
		sessionId: 'external-publish-source-1',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		newCommit: 'commit-new',
		...options,
	})
}

function mockExternalClone(overrides: Record<string, unknown> = {}) {
	mockModule.cloneExternalPublishWorkspace.mockResolvedValueOnce({
		...createExternalClone('commit-new'),
		...overrides,
	} as never)
}

function openSession(
	sessionId: string,
	options: Record<string, unknown> = {},
	env: Env = createEnv(),
) {
	return repoSession(env).openSession({
		sessionId,
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://example.com',
		sourceRoot: '/',
		...options,
	})
}

test('repo sessions inventory workspace bytes through open, mutation, and cleanup', async () => {
	setCommonSessionFixtures()
	const env = createEnv()
	const repo = repoSession(env)
	const inventory = {
		db: env.APP_DB,
		userId: ownerIdFromStored('user-1'),
		storageId: 'repo-session:session-1',
	}

	await expect(repo.getEstimatedBytes()).resolves.toEqual({
		estimatedBytes: 16_384,
	})
	await repo.openSession({
		...session,
		sourceId: 'source-1',
		baseUrl: 'https://example.com',
	})
	expect(mockModule.registerStorageBucketAndWait).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-1'),
		storageId: 'repo-session:session-1',
		kind: 'repo_session',
	})
	expect(mockModule.maybeRefreshStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			userId: ownerIdFromStored('user-1'),
			storageId: 'repo-session:session-1',
			readEstimatedBytes: expect.any(Function),
			waitUntil: expect.any(Function),
		}),
	)

	mockModule.maybeRefreshStorageBucketEstimate.mockClear()
	await repo.writeFile({
		...session,
		path: 'src/index.ts',
		content: 'export const ready = true\n',
	})
	expect(mockModule.maybeRefreshStorageBucketEstimate).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			storageId: 'repo-session:session-1',
		}),
	)

	await repo.discardSession(session)
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith(
		inventory,
	)

	mockModule.deleteStorageBucketInventory.mockClear()
	await repo.purgeSession(session)
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith(
		inventory,
	)
})

test('rebaseSession and publishSession use Artifacts username/password auth without token override', async () => {
	// Best-effort publish git-note attachment fails in this mocked git
	// environment and logs a warning; it is asserted at the end of the test.
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const packageFile = { 'package.json': userPackageJson }
	const repo = repoSession(createEnv(), await checkedPublishState(packageFile))
	const artifactsAuth = { username: 'x', password: 'art_source_secret' }
	const noToken = expect.not.objectContaining({ token: expect.anything() })

	await repo.rebaseSession(session)
	expect(mockModule.git.pull).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'main',
			...artifactsAuth,
		}),
	)
	expect(mockModule.git.pull).toHaveBeenCalledWith(noToken)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'sessions/session1',
			force: true,
			...artifactsAuth,
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(noToken)

	mockModule.git.pull.mockClear()
	mockModule.git.push.mockClear()
	mockModule.rawPush.mockClear()
	seedWorkspace(packageFile)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(packageFile, {
			repoId: 'source-repo',
			publishedCommit: 'commit-base',
		}),
	)
	await repo.publishSession({
		...session,
		force: true,
		destructiveOverwriteConfirmed: true,
	})
	expect(mockModule.git.push).toHaveBeenCalledTimes(1)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'sessions/session1',
			force: true,
			...artifactsAuth,
		}),
	)
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.objectContaining({
			fs: expect.objectContaining({
				promises: expect.objectContaining({
					rmdir: expect.any(Function),
					unlink: expect.any(Function),
				}),
			}),
			remote: 'origin',
			ref: 'sessions/session1',
			remoteRef: 'main',
			force: true,
		}),
	)
	const gitPushCalls: Array<Array<unknown>> = mockModule.git.push.mock.calls
	for (const call of gitPushCalls) {
		expect(call[0]).not.toHaveProperty('token')
	}

	mockModule.rawPush.mockClear()
	await expect(
		repo.cleanupSessionBranch({ ...session, reason: 'expired' }),
	).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		branch: 'sessions/session1',
		branchDeleted: true,
	})
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'sessions/session1',
			delete: true,
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('publish_git_note'),
		expect.anything(),
	)
})

test('cleanupSessionBranch removes the D1 session row when remote branch delete fails', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.rawPush.mockRejectedValueOnce(
		new TypeError("Cannot read properties of undefined (reading 'bind')"),
	)

	await expect(
		repoSession().cleanupSessionBranch({ ...session, reason: 'expired' }),
	).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		branch: 'sessions/session1',
		branchDeleted: false,
	})
	expect(deleteRepoSession).toHaveBeenCalledWith(expect.anything(), {
		userId: ownerIdFromStored('user-1'),
		sessionId: 'session-1',
	})
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: ownerIdFromStored('user-1'),
		storageId: 'repo-session:session-1',
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('repo session remote branch delete failed'),
	)
})

test('session teardown does not wipe blobs without a catalog row and keeps the row when R2 purge fails', async () => {
	restoreRepoSessionMockBaseline()
	const keepKey = 'repo-session:other-do/default/session/pack.pack'
	const sessionKey = 'repo-session:do-session-1/default/session/pack.pack'
	const bothKeys = [keepKey, sessionKey].sort()
	const blobs = createFakeRepoSessionBlobs({
		[sessionKey]: 2_000,
		[keepKey]: 9_000,
	})
	mockModule.getRepoSessionById.mockResolvedValue(null)
	const missingRowSession = repoSession(createEnv(blobs.bucket))

	await expect(missingRowSession.discardSession(session)).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		deleted: false,
	})
	expect([...blobs.objects.keys()].sort()).toEqual(bothKeys)
	expect(blobs.list).not.toHaveBeenCalled()
	expect(deleteRepoSession).not.toHaveBeenCalled()

	await expect(
		missingRowSession.cleanupSessionBranch({ ...session, reason: 'expired' }),
	).resolves.toEqual({
		ok: true,
		sessionId: 'session-1',
		branch: '',
		branchDeleted: true,
	})
	expect([...blobs.objects.keys()].sort()).toEqual(bothKeys)
	expect(deleteRepoSession).not.toHaveBeenCalled()

	setCommonSessionFixtures()
	const ownedBlobs = createFakeRepoSessionBlobs({
		[sessionKey]: 2_000,
		[keepKey]: 9_000,
	})
	await expect(
		repoSession(createEnv(ownedBlobs.bucket)).discardSession(session),
	).resolves.toEqual({ ok: true, sessionId: 'session-1', deleted: true })
	expect(mockModule.updateRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'session-1',
			userId: ownerIdFromStored('user-1'),
			status: 'discarded',
		}),
	)
	expect([...ownedBlobs.objects.keys()]).toEqual([keepKey])

	setCommonSessionFixtures()
	const failingBlobs = createFakeRepoSessionBlobs({ [sessionKey]: 2_000 })
	failingBlobs.list.mockRejectedValueOnce(new Error('R2 list failed'))
	vi.mocked(deleteRepoSession).mockClear()
	await expect(
		repoSession(createEnv(failingBlobs.bucket)).cleanupSessionBranch({
			...session,
			reason: 'expired',
		}),
	).rejects.toThrow('R2 list failed')
	expect(deleteRepoSession).not.toHaveBeenCalled()
	expect(mockModule.deleteStorageBucketInventory).not.toHaveBeenCalled()
})

test('applyPatch is all-or-nothing on size-limit failures and applies modify, delete, and rename hunks', async () => {
	setCommonSessionFixtures()
	seedWorkspace(
		{
			'src/keep.ts': 'export const keep = false\n',
			'src/delete.ts': 'export const remove = true\n',
			'src/old-name.ts': 'export const name = "old"\n',
		},
		{ glob: false },
	)
	const repo = repoSession()
	const keepHunk = [
		'--- a/src/keep.ts',
		'+++ b/src/keep.ts',
		'@@ -1 +1 @@',
		'-export const keep = false',
		'+export const keep = true',
	]

	await expect(
		repo.applyPatch({
			...session,
			patch: [
				...keepHunk,
				'--- /dev/null',
				'+++ b/assets/huge.txt',
				'@@ -0,0 +1 @@',
				`+${'x'.repeat(maxRepoSourceFileBytes + 1)}`,
			].join('\n'),
		}),
	).rejects.toThrow(/"assets\/huge\.txt".*per-file limit/s)
	expect(mockModule.workspaceWriteFile).not.toHaveBeenCalled()
	expect(mockModule.workspaceRm).not.toHaveBeenCalled()

	const modifyAndDelete = await repo.applyPatch({
		...session,
		patch: [
			...keepHunk,
			'--- a/src/delete.ts',
			'+++ /dev/null',
			'@@ -1 +0,0 @@',
			'-export const remove = true',
		].join('\n'),
	})
	expect(mockModule.workspaceWriteFile).toHaveBeenCalledWith(
		'/session/src/keep.ts',
		'export const keep = true\n',
	)
	expect(mockModule.workspaceRm).toHaveBeenCalledWith(
		'/session/src/delete.ts',
		{
			force: true,
		},
	)
	expect(modifyAndDelete.edits).toEqual([
		expect.objectContaining({
			path: 'src/keep.ts',
			content: 'export const keep = true\n',
		}),
		expect.objectContaining({ path: 'src/delete.ts', content: '' }),
	])
	expect(modifyAndDelete.edits[0]?.diff).toContain('src/keep.ts')
	expect(modifyAndDelete.edits[0]?.diff).not.toContain('src/delete.ts')
	expect(modifyAndDelete.edits[1]?.diff).toContain('src/delete.ts')
	expect(modifyAndDelete.edits[1]?.diff).not.toContain('src/keep.ts')

	const rename = await repo.applyPatch({
		...session,
		patch: [
			'--- a/src/old-name.ts',
			'+++ b/src/new-name.ts',
			'@@ -1 +1 @@',
			'-export const name = "old"',
			'+export const name = "new"',
		].join('\n'),
	})
	expect(mockModule.workspaceReadFile).toHaveBeenCalledWith(
		'/session/src/old-name.ts',
	)
	expect(mockModule.workspaceRm).toHaveBeenCalledWith(
		'/session/src/old-name.ts',
		{ force: true },
	)
	expect(mockModule.workspaceWriteFile).toHaveBeenCalledWith(
		'/session/src/new-name.ts',
		'export const name = "new"\n',
	)
	expect(rename.edits[0]).toEqual(
		expect.objectContaining({
			path: 'src/new-name.ts',
			content: 'export const name = "new"\n',
		}),
	)
})

test('applyEdits rejects oversized writes and batches mixing structural and content edits on one path', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceExists.mockResolvedValue(true)
	mockModule.workspaceReadFile.mockResolvedValue('export const value = 1\n')
	const repo = repoSession()

	await expect(
		repo.applyEdits({
			...session,
			edits: [
				{
					kind: 'write',
					path: 'assets/dataset.csv',
					content: 'x'.repeat(maxRepoSourceFileBytes + 1),
				},
			],
		}),
	).rejects.toThrow(/"assets\/dataset\.csv".*per-file limit.*Cloudflare R2/s)

	const write = { kind: 'write', content: 'export const a = 2\n' } as const
	const ambiguousBatches = [
		// delete + write on the same path (structural edits run last).
		[
			{ kind: 'delete', path: 'src/a.ts' },
			{ ...write, path: 'src/a.ts' },
		],
		// A rewritten move source would capture stale content; ./-prefixed
		// paths must still collide after resolution.
		[
			{ ...write, path: './src/a.ts' },
			{ kind: 'move', path: 'src/a.ts', to: 'src/b.ts' },
		],
		// In-workspace `..` aliases must collide after normalization.
		[
			{ ...write, path: 'src/../exports/a.ts' },
			{ kind: 'delete', path: 'exports/a.ts' },
		],
	] as const
	for (const edits of ambiguousBatches) {
		await expect(
			repo.applyEdits({ ...session, edits: [...edits] }),
		).rejects.toThrow(/cannot combine a delete\/move/)
	}
	expect(mockModule.workspaceWriteFile).not.toHaveBeenCalled()
	expect(mockModule.workspaceRm).not.toHaveBeenCalled()
})

test('applyEdits deletes and moves files, including grandfathered oversized files whose content is unchanged', async () => {
	setCommonSessionFixtures()
	seedWorkspace(
		{
			'src/remove.ts': 'export const gone = true\n',
			'src/old.ts': 'export const value = 1\n',
			'assets/huge.bin': 'x'.repeat(maxRepoSourceFileBytes + 1),
		},
		{ glob: false, exists: true },
	)
	const repo = repoSession()

	const deleted = await repo.applyEdits({
		...session,
		edits: [{ kind: 'delete', path: 'src/remove.ts' }],
	})
	expect(mockModule.workspaceRm).toHaveBeenCalledWith(
		'/session/src/remove.ts',
		{
			force: true,
		},
	)
	expect(deleted.totalChanged).toBe(1)
	expect(deleted.edits[0]).toMatchObject({
		path: 'src/remove.ts',
		changed: true,
		content: '',
	})

	const moved = await repo.applyEdits({
		...session,
		edits: [{ kind: 'move', path: 'src/old.ts', to: 'src/new.ts' }],
	})
	expect(mockModule.workspaceWriteFile).toHaveBeenCalledWith(
		'/session/src/new.ts',
		'export const value = 1\n',
	)
	expect(mockModule.workspaceRm).toHaveBeenCalledWith('/session/src/old.ts', {
		force: true,
	})
	expect(moved.edits[0]).toMatchObject({
		path: 'src/new.ts',
		content: 'export const value = 1\n',
	})

	await expect(
		repo.applyEdits({
			...session,
			edits: [
				{
					kind: 'move',
					path: 'assets/huge.bin',
					to: 'assets/huge-renamed.bin',
				},
			],
		}),
	).resolves.toMatchObject({ totalChanged: 1 })
})

test('restoreFiles restores modified files to the session base commit', async () => {
	setCommonSessionFixtures()
	mockModule.readBlob.mockResolvedValueOnce({
		blob: new TextEncoder().encode('base content\n'),
	})

	const result = await repoSession().restoreFiles({
		...session,
		paths: ['src/index.ts'],
	})

	expect(mockModule.readBlob).toHaveBeenCalledWith(
		expect.objectContaining({ filepath: 'src/index.ts', oid: 'commit-base' }),
	)
	expect(mockModule.workspaceWriteFileBytes).toHaveBeenCalledWith(
		'/session/src/index.ts',
		new TextEncoder().encode('base content\n'),
	)
	expect(result).toEqual({ commit: 'commit-base', restored: ['src/index.ts'] })
})

test('sessionCommit rejects empty commit messages', async () => {
	setCommonSessionFixtures()
	await expect(
		repoSession().sessionCommit({ ...session, message: '   ' }),
	).rejects.toThrow('Commit message cannot be empty.')
	expect(mockModule.git.add).not.toHaveBeenCalled()
	expect(mockModule.git.commit).not.toHaveBeenCalled()
})

function lastWorkspaceBackend() {
	return vi.mocked(createWorkspaceStateBackend).mock.results.at(-1)?.value as {
		applyEditPlan: ReturnType<typeof vi.fn>
	}
}

test('applyEdits rejects a write over the unified-diff line limit before applyEditPlan', async () => {
	setCommonSessionFixtures()

	await expect(
		repoSession().applyEdits({
			...session,
			edits: [
				{
					kind: 'write',
					path: 'assets/extracted.txt',
					content: `${'line\n'.repeat(maxRepoSourceFileDiffLines)}last`,
				},
			],
		}),
	).rejects.toThrow(
		/"assets\/extracted\.txt".*line limit for repo session unified diffs/s,
	)
	expect(lastWorkspaceBackend().applyEditPlan).not.toHaveBeenCalled()
})

test('applyEdits rejects replace on an existing file over the unified-diff line limit', async () => {
	setCommonSessionFixtures()
	seedWorkspace(
		{
			'assets/huge.txt': `${'old\n'.repeat(maxRepoSourceFileDiffLines)}tail`,
		},
		{ glob: false },
	)

	await expect(
		repoSession().applyEdits({
			...session,
			edits: [
				{
					kind: 'replace',
					path: 'assets/huge.txt',
					search: 'tail',
					replacement: 'next',
				},
			],
		}),
	).rejects.toThrow(
		/"assets\/huge\.txt".*line limit for repo session unified diffs/s,
	)
	expect(lastWorkspaceBackend().applyEditPlan).not.toHaveBeenCalled()
})

test('applyEdits remaps raw Cloudflare shell EFBIG from applyEditPlan', async () => {
	setCommonSessionFixtures()
	vi.mocked(createWorkspaceStateBackend).mockImplementationOnce(
		() =>
			({
				planEdits: vi.fn(),
				applyEditPlan: vi.fn(async () => {
					throw new Error('EFBIG: content too large for diff (max 10000 lines)')
				}),
				walkTree: vi.fn(),
			}) as unknown as ReturnType<typeof createWorkspaceStateBackend>,
	)

	await expect(
		repoSession().applyEdits({
			...session,
			edits: [
				{
					kind: 'write',
					path: 'src/small.ts',
					content: 'export const ok = true\n',
				},
			],
		}),
	).rejects.toThrow(
		/"src\/small\.ts".*line limit for repo session unified diffs/s,
	)
})

test('applyEdits composes multiple replace edits to the same file instead of keeping only the last', async () => {
	setCommonSessionFixtures()
	const lines = ['accountId', 'value', 'extra']
	seedWorkspace(
		{
			'src/ci-secrets.ts': [
				...lines.map((name) => `const ${name} = status.accountId`),
				'',
			].join('\n'),
		},
		{ glob: false },
	)

	const result = await repoSession().applyEdits({
		...session,
		edits: lines.map((name) => ({
			kind: 'replace' as const,
			path: 'src/ci-secrets.ts',
			search: `const ${name} = status.accountId`,
			replacement: `const ${name} = accountId`,
		})),
	})

	// Planner unit tests cover stepwise composition; here assert applyEdits
	// routes through that planner (shell planEdits would keep only the last).
	const composed = [
		'const accountId = accountId',
		'const value = accountId',
		'const extra = accountId',
		'',
	].join('\n')
	expect(lastWorkspaceBackend().applyEditPlan).toHaveBeenCalledWith(
		expect.objectContaining({
			totalChanged: 3,
			edits: expect.arrayContaining([
				expect.objectContaining({ changed: true, content: composed }),
			]),
		}),
		expect.objectContaining({ dryRun: undefined }),
	)
	expect(result.totalChanged).toBe(3)
	expect(result.edits.at(-1)?.content).toBe(composed)
})

test('openSession sanitizes repo names, persists namespace metadata, and rejects stale package source heads', async () => {
	const { remote: defaultRemote } = stubPackageSourceForOpenSession()
	const opened = await openSession(
		'job-runtime-package-job:1a0476b4-c1d6-47ad-802e-dd5f4631c919:event-runner-123e4567-e89b-12d3-a456-426614174000',
	)
	expect(opened.session_branch).toMatch(/^sessions\/[a-z0-9]+-[a-f0-9]{32}$/)
	expect(opened.session_branch).not.toContain(':')
	expect(mockModule.git.clone).toHaveBeenCalledWith(
		expect.objectContaining({ url: defaultRemote }),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({ remote: 'origin', ref: opened.session_branch }),
	)
	expect(
		mockModule.markEntitySourcePendingExternalReconcile,
	).toHaveBeenCalledWith(expect.anything(), {
		id: 'source-1',
		userId: ownerIdFromStored('user-1'),
		tokenExpiresAt: expect.any(String),
	})

	stubPackageSourceForOpenSession({
		publishedCommit: 'commit-release',
		defaultBranch: 'release',
	})
	mockModule.resolveArtifactDefaultBranchHead.mockResolvedValueOnce({
		defaultBranch: 'release',
		commit: 'commit-release',
		remote: artifactsRemote('package-event-runner'),
	})
	await openSession('session-release-branch')
	expect(insertRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ source_branch: 'release' }),
	)
	await expect(
		openSession('session-conflicting-branch', { defaultBranch: 'main' }),
	).rejects.toThrow(/published from "release"/)

	stubPackageSourceForOpenSession({ remoteNamespace: 'preview' })
	vi.mocked(insertRepoSession).mockClear()
	await openSession('session-preview-namespace', {}, {
		APP_DB: {},
		ARTIFACTS_NAMESPACE: 'preview',
	} as unknown as Env)
	expect(insertRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			session_branch: expect.stringMatching(/^sessions\//),
			source_branch: 'main',
		}),
	)

	restoreRepoSessionMockBaseline()
	mockModule.getRepoSessionById.mockResolvedValue(
		sessionRow({
			id: 'discarded-session',
			session_branch: 'sessions/discarded',
			status: 'discarded',
		}),
	)
	await expect(openSession('discarded-session')).rejects.toThrow(/is discarded/)

	stubPackageSourceForOpenSession({
		repoId: 'package-package-1',
		headCommit: null,
		createToken: false,
	})
	await expect(openSession('session-empty-source-head')).rejects.toThrow(
		/default branch has no HEAD/,
	)
	expect(mockModule.resolveArtifactSourceRepo).not.toHaveBeenCalled()

	stubPackageSourceForOpenSession({
		repoId: 'package-package-1',
		publishedCommit: 'commit-published',
		headCommit: 'commit-unpublished',
		createToken: false,
	})
	await expect(openSession('session-stale-source-head')).rejects.toThrow(
		/does not match published commit/,
	)
})

test('openSession wraps packfile corruption but leaves opaque Cloudflare internals bare', async () => {
	const { remote } = stubPackageSourceForOpenSession()
	mockModule.git.clone.mockRejectedValue(
		new Error(
			'An internal error caused this command to fail. Packfile payload corrupted: calculated abc but expected def.',
		),
	)
	const packfileError = openSession('session-packfile')
	await expect(packfileError).rejects.toThrow(
		new RegExp(
			`^Artifacts git clone failed for ${remote.replaceAll('.', '\\.')}:.*Packfile payload corrupted`,
			's',
		),
	)
	expect(mockModule.git.clone.mock.calls.length).toBeGreaterThanOrEqual(2)

	stubPackageSourceForOpenSession()
	mockModule.git.clone.mockRejectedValue(
		new Error('An internal error occurred.'),
	)
	const opaqueError = await openSession('session-opaque').catch(
		(thrown: unknown) => thrown,
	)
	expect(opaqueError).toBeInstanceOf(Error)
	expect((opaqueError as Error).message).toBe('An internal error occurred.')
	expect(mockModule.git.clone).toHaveBeenCalledTimes(1)
})

test('readFile retries D1 reads and falls back to cached sessions when replicas lag', async () => {
	setCommonSessionFixtures()
	const packageSource = sourceRow({
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'package-package-1',
		published_commit: 'commit-base',
		manifest_path: 'package.json',
	})
	mockModule.getRepoSessionById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(
			sessionRow({
				id: 'job-runtime-session-replica-lag',
				session_branch: 'sessions/jobruntimesessionreplicalag',
				last_checkpoint_commit: null,
			}),
		)
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(packageSource)
	mockModule.workspaceReadFile.mockResolvedValue(userPackageJson)

	await expect(
		repoSession().readFile({
			sessionId: 'job-runtime-session-replica-lag',
			userId: ownerIdFromStored('user-1'),
			path: 'package.json',
		}),
	).resolves.toEqual({
		path: 'package.json',
		content: userPackageJson,
	})
	expect(mockModule.getRepoSessionById).toHaveBeenCalledTimes(3)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(2)

	// A repo session re-reads the D1 rows on every call rather than pinning
	// the first ones it saw.
	setCommonSessionFixtures()
	const initialSource = {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package' as const,
		entity_id: 'package-1',
		repo_id: 'source-repo',
		published_commit: 'commit-initial',
		manifest_path: 'package.json',
		source_root: '/',
	}
	const sessionAt = (commit: string) =>
		sessionRow({ base_commit: commit, last_checkpoint_commit: commit })
	mockModule.getRepoSessionById
		.mockResolvedValueOnce(sessionAt('commit-initial'))
		.mockResolvedValueOnce(sessionAt('commit-rebased'))
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(initialSource)
		.mockResolvedValueOnce({
			...initialSource,
			published_commit: 'commit-moved',
		})
	mockModule.workspaceReadFile.mockResolvedValue('hello world')
	const updatedRowSession = repoSession()
	for (let read = 0; read < 2; read += 1) {
		await expect(
			updatedRowSession.readFile({ ...session, path: 'greeting.txt' }),
		).resolves.toEqual({ path: 'greeting.txt', content: 'hello world' })
	}
	expect(mockModule.getRepoSessionById).toHaveBeenCalledTimes(5)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledTimes(4)

	mockModule.getRepoSessionById.mockReset()
	mockModule.getEntitySourceById.mockReset()
	mockModule.getRepoSessionById
		.mockResolvedValueOnce(null)
		.mockResolvedValueOnce(null)
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(packageSource)
		.mockResolvedValueOnce(packageSource)
		.mockResolvedValueOnce(null)
	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.workspaceReadFile.mockResolvedValue('export default {}')
	const cachedFallbackSession = repoSession()
	await cachedFallbackSession.openSession({
		sessionId: 'job-runtime-session-1',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://example.com',
		sourceRoot: '/',
	})
	await expect(
		cachedFallbackSession.readFile({
			sessionId: 'job-runtime-session-1',
			userId: ownerIdFromStored('user-1'),
			path: 'src/index.ts',
		}),
	).resolves.toEqual({ path: 'src/index.ts', content: 'export default {}' })
})

test('publishSession persists the workspace snapshot to BUNDLE_ARTIFACTS_KV for downstream readers and never leaves inconsistent published commits when snapshot collection or persistence fails', async () => {
	const packageFiles = {
		'package.json': userPackageJson,
		'src/index.ts': 'export default {}',
	}
	const publishChecked = async (
		headCommit: string,
		files: Record<string, string | null>,
		options: { fallback?: string | null; setup?: () => void } = {},
	) => {
		preparePublish(headCommit, files, options.fallback ?? '')
		options.setup?.()
		const hashed = Object.fromEntries(
			Object.entries(files).filter(
				(entry): entry is [string, string] => typeof entry[1] === 'string',
			),
		)
		return publish({ force: false }, kvEnv(), await checkedPublishState(hashed))
	}

	await expect(
		publishChecked('commit-published-fail', packageFiles, {
			setup() {
				mockModule.writePublishedSourceSnapshot.mockRejectedValueOnce(
					new Error('kv write failed'),
				)
			},
		}),
	).rejects.toThrow('kv write failed')
	// Snapshot write runs before the D1 pointer flip, so a KV failure must
	// leave published_commit on the previous tip (no advance, no revert).
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	await expect(
		publishChecked(
			'commit-published-collect-fail',
			{ 'package.json': userPackageJson, 'src/index.ts': null },
			{ fallback: null },
		),
	).rejects.toThrow(/Failed to read repo session file/)
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	consoleWarn.mockImplementation(() => {})
	const files = {
		...packageFiles,
		'.git/config': '',
	}
	preparePublish('commit-published-new', files)
	mockModule.workspaceGlob.mockClear()
	mockModule.workspaceReadFileBytes.mockClear()
	mockModule.writePublishedSourceSnapshot.mockClear()
	mockModule.updateEntitySource.mockClear()
	await publish(
		{ force: false },
		kvEnv(),
		await checkedPublishState(packageFiles),
	)
	const writeOrder =
		mockModule.writePublishedSourceSnapshot.mock.invocationCallOrder[0]
	const updateOrder = mockModule.updateEntitySource.mock.invocationCallOrder[0]
	expect(writeOrder).toBeDefined()
	expect(updateOrder).toBeDefined()
	expect(writeOrder!).toBeLessThan(updateOrder!)
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			source: expect.objectContaining({
				id: 'source-1',
				published_commit: 'commit-published-new',
			}),
			files: packageFiles,
		}),
	)
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-published-new',
		}),
	)
	expect(mockModule.workspaceGlob).toHaveBeenCalledTimes(1)
	expect(mockModule.workspaceReadFileBytes).toHaveBeenCalledTimes(
		Object.keys(packageFiles).length,
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('publish_git_note'),
		expect.anything(),
	)
})

test('publishFromExternalRef rejects stale expected HEAD values and checks fast-forward ancestry through the ephemeral clone', async () => {
	setCommonSessionFixtures()
	// Clone tip is the remote default-branch HEAD at clone time; a mismatch
	// with expectedHead means the Artifacts tip moved.
	mockExternalClone()
	await expect(
		publishExternal(
			{ newCommit: 'commit-stale', expectedHead: 'commit-stale' },
			createEnv(),
		),
	).rejects.toThrow(
		'Artifacts HEAD changed from "commit-stale" to "commit-new" before publish.',
	)
	expect(mockModule.resolveArtifactDefaultBranchHead).not.toHaveBeenCalled()

	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({
			repo_id: 'source-repo',
			published_commit: 'commit-old',
		}),
	)
	const isAncestorCommit = vi.fn(
		async ({ ancestor, descendant }) =>
			ancestor === 'commit-old' && descendant === 'commit-new',
	)
	mockExternalClone({ isAncestorCommit })

	const result = await publishExternal({ deferBundleCheckToRebuild: true })

	expect(result).toEqual(
		expect.objectContaining({
			status: 'published',
			phase_timings: expect.objectContaining({ clone_ms: expect.any(Number) }),
		}),
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ deferBundleCheckToRebuild: true }),
	)
	expect(mockModule.workspaceGlob).not.toHaveBeenCalled()
	expect(isAncestorCommit).toHaveBeenCalledWith({
		ancestor: 'commit-old',
		descendant: 'commit-new',
	})
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ publishedCommit: 'commit-new' }),
	)
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			files: {
				'package.json': '{"name":"@kody/demo"}',
				'index.ts': 'export const ready = true\n',
			},
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'publish_git_note failed',
		expect.objectContaining({
			scope: 'repo.publishFromExternalRef.publish-git-note',
		}),
	)
})

test('isolated check phases and artifact rebuilds load staged files from KV, skip built targets, and reject expired or cross-user staging keys', async () => {
	restoreRepoSessionMockBaseline()
	const staged = { sourceFiles: { 'package.json': '{"name":"@kody/demo"}' } }
	const checkKv = { get: vi.fn(async () => staged) }
	const checkRepo = repoSession(kvEnv(checkKv))
	const typecheck = (stagingKey: string) =>
		checkRepo.runIsolatedCheckPhase({
			phase: 'typecheck',
			stagingKey,
			userId: ownerIdFromStored('user-1'),
			typecheckTargets: [
				{ path: 'src/index.ts', kind: 'callable', emittedEventTopics: [] },
			],
		})

	const bundleOutcome = await checkRepo.runIsolatedCheckPhase({
		phase: 'bundle-chunk',
		stagingKey: 'repo-checks-staging:v1:user-1:abc',
		baseUrl: '/',
		userId: ownerIdFromStored('user-1'),
		bundleTargets: [{ path: 'src/index.ts', bundleKind: 'callable' }],
	})
	expect(bundleOutcome.ok).toBe(true)
	expect(mockModule.validatePackageBundles).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			sourceFiles: staged.sourceFiles,
			entryPoints: [{ path: 'src/index.ts', bundleKind: 'callable' }],
		}),
	)

	const typecheckOutcome = await typecheck('repo-checks-staging:v1:user-1:abc')
	expect(typecheckOutcome.ok).toBe(true)
	expect(mockModule.runPackageTypecheckLanguageService).toHaveBeenCalledWith({
		sourceFiles: staged.sourceFiles,
		targets: [
			{ path: 'src/index.ts', kind: 'callable', emittedEventTopics: [] },
		],
	})

	const rebuildKv = {
		get: vi.fn(async () => ({
			sourceFiles: {
				'package.json': demoPackageJson,
				'index.ts': 'export const ready = true\n',
			},
		})),
		put: vi.fn(async () => undefined),
	}
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow())
	const rebuildRepo = repoSession(kvEnv(rebuildKv))
	const target = {
		kind: 'module' as const,
		artifactName: '.',
		entryPoint: 'index.ts',
		bundleKind: 'module' as const,
	}
	const rebuild = (
		options: { stagingKey?: string; baseUrl?: string; force?: boolean } = {},
	) =>
		rebuildRepo.runIsolatedArtifactRebuild({
			stagingKey: 'repo-artifact-rebuild-staging:v1:user-1:abc',
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			publishedCommit: 'commit-1',
			targets: [target],
			...options,
		})
	const rebuiltTarget = {
		ok: true,
		results: [expect.objectContaining({ kvKey: 'kv:artifact', target })],
	}

	mockModule.isPublishedPackageArtifactBuiltForCommit.mockResolvedValueOnce(
		true,
	)
	await expect(rebuild()).resolves.toMatchObject({
		ok: true,
		results: [expect.objectContaining({ skipped: true, target })],
	})
	expect(rebuildKv.get).not.toHaveBeenCalled()
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).not.toHaveBeenCalled()

	await expect(
		rebuild({ baseUrl: 'https://kody.test', force: true }),
	).resolves.toMatchObject(rebuiltTarget)
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).toHaveBeenCalledTimes(1)

	await expect(
		rebuild({ baseUrl: 'https://kody.test' }),
	).resolves.toMatchObject(rebuiltTarget)
	expect(mockModule.persistPublishedPackageArtifactTarget).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			target,
			source: expect.objectContaining({ published_commit: 'commit-1' }),
		}),
	)

	const stagedRunners = [
		[checkKv.get, 'repo-checks-staging:v1', typecheck],
		[
			rebuildKv.get,
			'repo-artifact-rebuild-staging:v1',
			(stagingKey: string) => rebuild({ stagingKey }),
		],
	] as const
	for (const [kvGet, prefix, run] of stagedRunners) {
		kvGet.mockResolvedValueOnce(null as never)
		const expired = await run(`${prefix}:user-1:gone`)
		expect(expired.ok).toBe(false)
		expect(expired.message).toContain('staging data expired')

		kvGet.mockClear()
		const crossUser = await run(`${prefix}:user-2:abc`)
		expect(crossUser.ok).toBe(false)
		expect(crossUser.message).toContain(
			'does not belong to the requesting user',
		)
		expect(kvGet).not.toHaveBeenCalled()
	}
})

test('published artifact rebuild stages the published snapshot first and falls back to the session workspace once', async () => {
	const listTargets = () =>
		repoSession({ APP_DB: {} } as Env).listPublishedPackageArtifactTargets({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
		})
	async function stagedSourceFiles(publishedCommit = 'commit-1') {
		const put = vi.fn(
			async (_key: string, _body: string, _options: unknown) => undefined,
		)
		const staged = await repoSession(
			kvEnv({ put }),
		).stagePublishedPackageArtifactRebuild({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			publishedCommit,
		})
		expect(
			staged.stagingKey.startsWith('repo-artifact-rebuild-staging:v1:user-1:'),
		).toBe(true)
		expect(put).toHaveBeenCalledTimes(1)
		expect(put).toHaveBeenCalledWith(staged.stagingKey, expect.any(String), {
			expirationTtl: 15 * 60,
		})
		const payload = JSON.parse(put.mock.calls[0]![1]) as {
			sourceFiles: Record<string, string>
			publishedCommit: string
		}
		expect(payload.publishedCommit).toBe(publishedCommit)
		return payload.sourceFiles
	}
	const manifestSnapshot = (
		manifestContent: string,
	): PublishedSourceManifestSnapshot => ({
		version: 1,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		manifestContent,
		createdAt: '2026-08-17T20:00:00.000Z',
	})

	// No published snapshot: the session workspace is collected once.
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow())
	const workspaceFiles = {
		'package.json': demoPackageJson,
		'index.ts': 'export const ready = true\n',
	}
	seedWorkspace(workspaceFiles, { fallback: null })
	await expect(stagedSourceFiles()).resolves.toEqual(workspaceFiles)
	expect(mockModule.workspaceGlob).toHaveBeenCalledTimes(1)

	// Empty session workspace: targets and staged files come from the
	// published snapshot.
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow())
	mockModule.workspaceReadFile.mockResolvedValue(null)
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue(
		manifestSnapshot(demoPackageJson),
	)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(workspaceFiles),
	)
	await expect(listTargets()).resolves.toEqual([
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'index.ts',
			bundleKind: 'module',
		},
		{
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'index.ts',
			bundleKind: 'importable-module',
		},
	])
	expect(mockModule.loadPublishedSourceManifestSnapshot).toHaveBeenCalledTimes(
		1,
	)
	await expect(stagedSourceFiles()).resolves.toEqual(workspaceFiles)
	expect(mockModule.loadPublishedSourceSnapshot).toHaveBeenCalledTimes(1)

	// A leftover session workspace never wins over the published snapshot.
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow())
	const snapshotFiles = {
		'package.json': demoPackageJson,
		'index.ts': 'export const fromSnapshot = true\n',
	}
	seedWorkspace(
		{
			'package.json':
				'{"name":"@kody/stale","exports":{".":"./index.ts"},"kody":{"id":"stale","description":"Stale"}}',
			'index.ts': 'export const fromWorkspace = true\n',
		},
		{ fallback: null },
	)
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue(
		manifestSnapshot(demoPackageJson),
	)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(snapshotFiles),
	)
	await expect(listTargets()).resolves.toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'module',
				artifactName: '.',
				entryPoint: 'index.ts',
			}),
		]),
	)
	expect(mockModule.loadPublishedSourceManifestSnapshot).toHaveBeenCalledTimes(
		1,
	)
	expect(mockModule.workspaceReadFile).not.toHaveBeenCalled()
	await expect(stagedSourceFiles()).resolves.toEqual(snapshotFiles)
	expect(mockModule.workspaceGlob).not.toHaveBeenCalled()
})
test('already_published external publish refreshes the snapshot from the in-memory clone only when it differs', async () => {
	const cloneFiles = {
		'package.json': demoPackageJson,
		'index.ts': 'export const fromClone = true\n',
	}
	// [stored snapshot, force_artifact_rebuild, invalidateExistingArtifacts
	// (null = snapshot left untouched)]
	const cases = [
		[null, false, false],
		[{ files: cloneFiles }, false, null],
		[
			{ files: { ...cloneFiles, 'index.ts': 'export const stale = true\n' } },
			true,
			true,
		],
	] as const
	for (const [stored, forceRebuild, invalidate] of cases) {
		setCommonSessionFixtures()
		mockModule.getEntitySourceById.mockResolvedValue(
			sourceRow({ repo_id: 'source-repo', published_commit: 'commit-new' }),
		)
		mockModule.loadPublishedSourceSnapshot.mockResolvedValueOnce(
			stored as never,
		)
		const collectFiles = vi.fn(async () => cloneFiles)
		mockExternalClone({ collectFiles })

		await expect(publishExternal()).resolves.toEqual({
			status: 'already_published',
			published_commit: 'commit-new',
			force_artifact_rebuild: forceRebuild,
			phase_timings: { clone_ms: expect.any(Number) },
		})
		expect(collectFiles).toHaveBeenCalledTimes(1)
		expect(mockModule.loadPublishedSourceSnapshot).toHaveBeenCalledTimes(1)
		expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
		expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
		// Live artifacts are never deleted; a mismatch only invalidates leftovers.
		expect(mockModule.deletePublishedArtifactsForSource).not.toHaveBeenCalled()
		if (invalidate === null) {
			expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
		} else {
			expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					source: expect.objectContaining({ published_commit: 'commit-new' }),
					files: cloneFiles,
					invalidateExistingArtifacts: invalidate,
				}),
			)
		}
	}

	setCommonSessionFixtures()
	consoleWarn.mockImplementation(() => {})
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({ repo_id: 'source-repo', published_commit: 'commit-new' }),
	)
	mockExternalClone({
		collectFiles: vi.fn(async () => {
			throw new Error('clone files unreadable')
		}),
	})
	// collectFiles runs before publish so a D1 race cannot finalize without a
	// binary-safe map; failure never reaches the already_published refresh warn.
	await expect(publishExternal()).rejects.toThrow('clone files unreadable')
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.deletePublishedArtifactsForSource).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
	expect(consoleWarn).not.toHaveBeenCalledWith(
		'already_published snapshot refresh failed',
		expect.anything(),
	)
})

test('publishSession maps non-fast-forward PushRejectedError to base_moved without force', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.rawPush.mockRejectedValueOnce(
		Object.assign(
			new Error(
				'Push rejected because it was not a simple fast-forward. Use "force: true" to override.',
			),
			{ name: 'PushRejectedError', code: 'PushRejectedError' },
		),
	)
	const packageFile = { 'package.json': userPackageJson }
	seedWorkspace(packageFile)
	const state = await checkedPublishState(packageFile)
	// Post-rejection tip refresh (precheck uses D1 published_commit only).
	mockModule.resolveArtifactSourceHead.mockResolvedValueOnce({
		branch: 'main',
		commit: 'commit-published-new',
	})

	await expect(
		repoSession(createEnv(), state).publishSession(session),
	).resolves.toEqual({
		status: 'base_moved',
		sessionId: 'session-1',
		publishedCommit: null,
		sessionBaseCommit: 'commit-base',
		currentPublishedCommit: 'commit-published-new',
		repairHint: 'repoRebaseSession',
		message:
			'The source repo rejected a non-fast-forward publish. Rebase the session before publishing.',
	})
	expect(mockModule.resolveArtifactSourceHead).toHaveBeenCalledTimes(1)
	expect(mockModule.resolveArtifactSourceHead).toHaveBeenCalledWith(
		expect.anything(),
		'source-repo',
	)
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({ ref: 'sessions/session1', force: true }),
	)
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.not.objectContaining({ force: true }),
	)
})

test('runChecks forwards expectedPackageScope for a still-plain repo so promote can run package checks', async () => {
	setCommonSessionFixtures()
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({
			entity_kind: 'repo',
			entity_id: 'repo-1',
			repo_id: 'source-repo',
			published_commit: null,
		}),
	)
	const result = await repoSession().runChecks({
		...session,
		expectedPackageScope: 'user',
	})
	expect(result.ok).toBe(true)
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ expectedPackageScope: 'user' }),
	)
})

test('publishSession requires overwrite confirmation for forced publishes of already-published packages, and a confirmed overwrite with promotePublished false stays additive for locked fleet publishes', async () => {
	setCommonSessionFixtures()
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({ repo_id: 'source-repo', published_commit: 'commit-base' }),
	)

	await expect(publish({}, createEnv())).rejects.toThrow(
		'repo forced publish would overwrite existing package source "source-1"',
	)
	expect(mockModule.git.push).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	consoleWarn.mockImplementation(() => {})
	preparePublish('commit-additive-locked', {
		'package.json': userPackageJson,
		'src/index.ts': 'export const next = true\n',
		'.git/config': '',
	})
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({ repo_id: 'source-repo', published_commit: 'commit-base' }),
	)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(
			{
				'package.json': userPackageJson,
				'src/index.ts': 'export const prior = true\n',
			},
			{
				repoId: 'source-repo',
				publishedCommit: 'commit-base',
				createdAt: '2026-09-28T00:00:00.000Z',
			},
		),
	)

	const result = await publish({
		destructiveOverwriteConfirmed: true,
		promotePublished: false,
	})

	expect(result).toMatchObject({
		status: 'ok',
		publishedCommit: 'commit-additive-locked',
	})
	expect(mockModule.git.commit).toHaveBeenCalled()
	expect(mockModule.rawCommit).not.toHaveBeenCalled()
	expect(mockModule.rawPush).not.toHaveBeenCalledWith(
		expect.objectContaining({ delete: true }),
	)
})

test('confirmed destructive overwrite replaces history with an orphan root commit and deletes the session ref', async () => {
	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const priorCanaryCommit = 'commit-with-canary'
	preparePublish(priorCanaryCommit, {
		'package.json': userPackageJson,
		'src/index.ts': 'export const ready = true\n',
		'.git/config': '',
	})
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({ repo_id: 'source-repo', published_commit: priorCanaryCommit }),
	)
	mockModule.getRepoSessionById.mockResolvedValue(
		sessionRow({
			session_branch: 'sessions/sourcesync-canary',
			base_commit: priorCanaryCommit,
			last_checkpoint_commit: priorCanaryCommit,
		}),
	)
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(
			{
				'package.json': userPackageJson,
				'src/index.ts': 'export const canary = "FAKE-CANARY-7f3a"\n',
			},
			{
				repoId: 'source-repo',
				publishedCommit: priorCanaryCommit,
				createdAt: '2026-09-28T00:00:00.000Z',
			},
		),
	)
	mockModule.listArtifactServerRefs.mockResolvedValue([
		{ ref: 'refs/heads/sessions/sourcesync-canary', oid: priorCanaryCommit },
		{
			ref: 'refs/heads/sessions/sourcesync-stale-prior',
			oid: priorCanaryCommit,
		},
		{ ref: 'refs/heads/main', oid: priorCanaryCommit },
	])

	const result = await publish({ destructiveOverwriteConfirmed: true })

	expect(result).toMatchObject({
		status: 'ok',
		publishedCommit: 'commit-orphan-root',
	})
	// Shell commit stays additive; history replace must use isomorphic-git
	// with an empty parent list so the prior canary commit is not an ancestor.
	expect(mockModule.git.commit).not.toHaveBeenCalled()
	expect(mockModule.rawCommit).toHaveBeenCalledTimes(1)
	expect(mockModule.rawCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			parent: [],
			message: 'Publish repo session session-1',
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({ ref: 'sessions/sourcesync-canary', force: true }),
	)
	expect(mockModule.rawPush).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'sessions/sourcesync-canary',
			remoteRef: 'main',
			force: true,
		}),
	)
	expect(mockModule.listArtifactServerRefs).toHaveBeenCalledWith(
		expect.objectContaining({ prefix: 'refs/heads/sessions/' }),
	)
	for (const ref of [
		'sessions/sourcesync-canary',
		'sessions/sourcesync-stale-prior',
	]) {
		expect(mockModule.rawPush).toHaveBeenCalledWith(
			expect.objectContaining({ ref, delete: true }),
		)
	}
	expect(mockModule.writePublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			source: expect.objectContaining({
				published_commit: 'commit-orphan-root',
			}),
			files: expect.objectContaining({
				'src/index.ts': 'export const ready = true\n',
			}),
		}),
	)
	const publishedFiles =
		mockModule.writePublishedSourceSnapshot.mock.calls[0]![0].files
	expect(JSON.stringify(publishedFiles)).not.toContain('FAKE-CANARY-7f3a')
})
