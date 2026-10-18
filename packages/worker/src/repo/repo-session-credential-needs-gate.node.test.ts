import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type Workspace } from '@cloudflare/shell'
import type git from 'isomorphic-git'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as Checks from './checks.ts'
import type * as EntitySources from './entity-sources.ts'
import type * as ExternalPublishClone from './external-publish-clone.ts'
import type * as RepoSessions from './repo-sessions.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import type * as SavedPackageRepo from '#worker/package-registry/repo.ts'
import type * as StorageBuckets from '#worker/storage-buckets/service.ts'
import type * as CredentialNeedsApproval from '#worker/credentials/credential-needs-approval.ts'
import {
	repoSessionMockModule as mockModule,
	checkedPublishState,
	createDurableObjectState,
	createEnv,
	sessionRow,
	setCommonSessionFixtures,
} from '#worker/test-support/repo-session-do.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

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

const { RepoSession } = await import('./repo-session-do.ts')

const userPackageJson =
	'{"name":"@user/demo","exports":{".":"./src/index.ts"},"kody":{"id":"demo","description":"Demo"}}'

function repoSession(
	env: Env = createEnv(),
	state = createDurableObjectState(),
) {
	return new RepoSession(state, env)
}

const session = { sessionId: 'session-1', userId: ownerIdFromStored('user-1') }

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

test('a publish paused for credential needs keeps the source branch and records the session for approval', async () => {
	setCommonSessionFixtures()
	const packageFile = { 'package.json': userPackageJson }
	seedWorkspace(packageFile)
	const state = await checkedPublishState(packageFile)
	const approval = {
		requestId: 'request-1',
		packageId: 'package-1',
		packageName: '@user/pkg',
		kodyId: 'pkg',
		pendingCommit: 'commit-paused',
		changes: [],
		message: 'Package "@user/pkg" changed its credential needs.',
	}
	needsGate.requireCredentialNeedsApproval.mockResolvedValueOnce(approval)
	mockModule.rawPush.mockClear()
	mockModule.updateRepoSession.mockClear()

	await expect(
		repoSession(createEnv(), state).publishSession(session),
	).resolves.toMatchObject({
		status: 'approval_required',
		publishedCommit: null,
		approval,
	})
	expect(needsGate.requireCredentialNeedsApproval).toHaveBeenCalledWith(
		expect.objectContaining({
			pausedSession: expect.objectContaining({ sessionId: 'session-1' }),
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({ ref: 'sessions/session1', force: true }),
	)
	expect(mockModule.rawPush).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.updateRepoSession).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'session-1',
			lastCheckpointAt: expect.any(String),
		}),
	)

	await expect(
		repoSession(createEnv(), state).publishSession({
			...session,
			expectedHeadCommit: 'commit-other',
		}),
	).rejects.toThrow(/no longer holds paused commit commit-other/)
})

test('a locked package keeps its locked-publish flow without pausing for credential needs', async () => {
	setCommonSessionFixtures()
	const packageFile = { 'package.json': userPackageJson }
	seedWorkspace(packageFile)
	const state = await checkedPublishState(packageFile)
	// Lock and the additive allowed-packages notice each look up the package
	// independently so warning failures cannot fail-open the lock gate.
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		name: '@user/demo',
		lockedAt: '2026-10-13T00:00:00.000Z',
	} as never)
	needsGate.requireCredentialNeedsApproval.mockClear()

	await expect(
		repoSession(createEnv(), state).publishSession(session),
	).resolves.toMatchObject({ status: 'locked', publishedCommit: null })
	expect(needsGate.requireCredentialNeedsApproval).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
})

test('publishSession releases storage inventory after a successful publish', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const packageFile = { 'package.json': userPackageJson }
	seedWorkspace(packageFile)
	const state = await checkedPublishState(packageFile)
	const { publishedSessionScratchReleasedNotice } =
		await import('./repo-session-do.ts')
	const result = await repoSession(createEnv(), state).publishSession(session)
	expect(result).toMatchObject({ status: 'ok' })
	expect(result.status === 'ok' && result.message).toContain(
		publishedSessionScratchReleasedNotice,
	)
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalledWith({
		db: expect.anything(),
		userId: ownerIdFromStored('user-1'),
		storageId: 'repo-session:session-1',
	})
	expect(mockModule.maybeRefreshStorageBucketEstimate).not.toHaveBeenCalled()
})

test('publishSession stays ok when scratch inventory delete throws', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	const packageFile = { 'package.json': userPackageJson }
	seedWorkspace(packageFile)
	const state = await checkedPublishState(packageFile)
	mockModule.deleteStorageBucketInventory.mockRejectedValueOnce(
		new Error('d1 inventory delete failed'),
	)
	await expect(
		repoSession(createEnv(), state).publishSession(session),
	).resolves.toMatchObject({ status: 'ok' })
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('published session scratch release failed'),
	)
})

test('getSessionInfo heals published inventory without failing on cleanup errors', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.getRepoSessionById.mockResolvedValue(
		sessionRow({
			id: 'session-1',
			status: 'published',
			expires_at: '2026-11-01T00:00:00.000Z',
		}),
	)
	mockModule.storageBucketInventoryExists.mockResolvedValueOnce(true)
	mockModule.deleteStorageBucketInventory.mockRejectedValueOnce(
		new Error('inventory delete failed'),
	)
	await expect(repoSession().getSessionInfo(session)).resolves.toMatchObject({
		id: 'session-1',
	})
})
