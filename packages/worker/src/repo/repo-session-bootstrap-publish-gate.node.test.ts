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
import type * as RepoSessions from './repo-sessions.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import type * as SavedPackageRepo from '#worker/package-registry/repo.ts'
import type * as StorageBuckets from '#worker/storage-buckets/service.ts'
import {
	repoSessionMockModule as mockModule,
	restoreRepoSessionMockBaseline,
	createDurableObjectState,
	createEnv,
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

test('bootstrapSource first-publishes from dest HEAD without replacing the forked tree', async () => {
	consoleWarn.mockImplementation(() => {})
	const unpublishedSource = sourceRow({
		published_commit: null,
		manifest_path: 'package.json',
	})
	const bootstrap = (sessionId: string, existingHeadCommit?: string) =>
		repoSession().bootstrapSource({
			sessionId,
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			...(existingHeadCommit ? { existingHeadCommit } : {}),
			bootstrapAccess: {
				defaultBranch: 'main',
				remote: artifactsRemote('package-package-1'),
				token: 'art_v1_bootstrap?expires=1760000000',
				expiresAt: '2025-10-09T08:53:20.000Z',
			},
			edits: [
				{ kind: 'write', path: 'package.json', content: userPackageJson },
			],
		})
	const destWorkspaceFiles = {
		'package.json': userPackageJson,
		'src/index.ts': 'export const ready = true\n',
		'README.md': 'forked dest tree',
	}

	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(unpublishedSource)
	seedWorkspace(destWorkspaceFiles, { fallback: null })
	mockModule.gitState.headCommit = 'commit-dest-head'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	const cloned = await bootstrap('session-bootstrap-fork', 'commit-dest-head')
	expect(cloned.publishedCommit).toBe('commit-dest-head')
	expect(cloned.files).toEqual(destWorkspaceFiles)
	expect(mockModule.git.clone).toHaveBeenCalledWith(
		expect.objectContaining({ branch: 'main', singleBranch: true }),
	)
	expect(mockModule.git.init).not.toHaveBeenCalled()
	expect(mockModule.runRepoChecks).toHaveBeenCalled()
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			id: 'source-1',
			publishedCommit: 'commit-dest-head',
		}),
	)

	restoreRepoSessionMockBaseline()
	mockModule.gitState.headCommit = 'commit-other'
	await expect(
		bootstrap('session-bootstrap-mismatch', 'commit-dest-head'),
	).rejects.toThrow(/does not match expected "commit-dest-head"/)
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()

	restoreRepoSessionMockBaseline()
	mockModule.workspaceReadFile.mockResolvedValue(userPackageJson)
	mockModule.gitState.headCommit = 'commit-empty-bootstrap'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	await bootstrap('session-bootstrap-empty')
	expect(mockModule.git.init).toHaveBeenCalled()
	expect(mockModule.git.clone).not.toHaveBeenCalled()
})

test('bootstrapSource runs publish repo checks before advancing a package published_commit', async () => {
	consoleWarn.mockImplementation(() => {})
	const unpublishedPackage = sourceRow({
		published_commit: null,
		manifest_path: 'package.json',
	})
	const files = {
		'package.json': userPackageJson,
		'src/index.ts': 'export const ready = true\n',
		'README.md': '# Demo\n',
		'AGENTS.md': '# Agents\n',
	}
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(unpublishedPackage)
	seedWorkspace(files, { fallback: null })
	mockModule.gitState.headCommit = 'commit-bootstrap-pkg'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.runRepoChecks.mockResolvedValueOnce({
		ok: false,
		results: [
			{ kind: 'typecheck', ok: false, message: 'src/index.ts type error' },
		],
		manifest: null,
		sourceFiles: files,
	})

	await expect(
		repoSession().bootstrapSource({
			sessionId: 'session-bootstrap-checks',
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			bootstrapAccess: {
				defaultBranch: 'main',
				remote: artifactsRemote('package-package-1'),
				token: 'art_v1_bootstrap?expires=1760000000',
				expiresAt: '2025-10-09T08:53:20.000Z',
			},
			edits: [
				{ kind: 'write', path: 'package.json', content: userPackageJson },
				{ kind: 'write', path: 'src/index.ts', content: files['src/index.ts'] },
			],
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof Error &&
			error.name === 'RepoChecksFailedError' &&
			error.message === 'src/index.ts type error',
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalled()
	expect(mockModule.git.push).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
	expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()

	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(unpublishedPackage)
	seedWorkspace(files, { fallback: null })
	mockModule.gitState.headCommit = 'commit-bootstrap-pkg-ok'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	const ok = await repoSession().bootstrapSource({
		sessionId: 'session-bootstrap-checks-ok',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: artifactsRemote('package-package-1'),
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
		edits: [
			{ kind: 'write', path: 'package.json', content: userPackageJson },
			{ kind: 'write', path: 'src/index.ts', content: files['src/index.ts'] },
		],
	})
	expect(ok.publishedCommit).toBe('commit-bootstrap-pkg-ok')
	expect(mockModule.runRepoChecks).toHaveBeenCalled()
	expect(mockModule.runRepoChecks.mock.calls.at(-1)?.[0]).not.toHaveProperty(
		'requirePackageDocs',
	)
	expect(mockModule.git.push).toHaveBeenCalled()
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			publishedCommit: 'commit-bootstrap-pkg-ok',
		}),
	)

	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(unpublishedPackage)
	seedWorkspace(files, { fallback: null })
	mockModule.gitState.headCommit = 'commit-bootstrap-docs-exempt'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	await repoSession().bootstrapSource({
		sessionId: 'session-bootstrap-docs-exempt',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		requirePackageDocs: false,
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: artifactsRemote('package-package-1'),
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
		edits: [
			{ kind: 'write', path: 'package.json', content: userPackageJson },
			{ kind: 'write', path: 'src/index.ts', content: files['src/index.ts'] },
		],
	})
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ requirePackageDocs: false }),
	)

	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(unpublishedPackage)
	seedWorkspace(files, { fallback: null })
	mockModule.gitState.headCommit = 'commit-bootstrap-scope'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	await repoSession().bootstrapSource({
		sessionId: 'session-bootstrap-scope',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		expectedPackageScope: 'renamed-user',
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: artifactsRemote('package-package-1'),
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
		edits: [
			{ kind: 'write', path: 'package.json', content: userPackageJson },
			{ kind: 'write', path: 'src/index.ts', content: files['src/index.ts'] },
		],
	})
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({ expectedPackageScope: 'renamed-user' }),
	)

	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(unpublishedPackage)
	seedWorkspace(files, { fallback: null })
	mockModule.gitState.headCommit = 'commit-bootstrap-skip-checks'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	mockModule.runRepoChecks.mockClear()
	await repoSession().bootstrapSource({
		sessionId: 'session-bootstrap-skip-checks',
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		runPublishChecks: false,
		bootstrapAccess: {
			defaultBranch: 'main',
			remote: artifactsRemote('package-package-1'),
			token: 'art_v1_bootstrap?expires=1760000000',
			expiresAt: '2025-10-09T08:53:20.000Z',
		},
		edits: [
			{ kind: 'write', path: 'package.json', content: userPackageJson },
			{ kind: 'write', path: 'src/index.ts', content: files['src/index.ts'] },
		],
	})
	expect(mockModule.runRepoChecks).not.toHaveBeenCalled()
	expect(mockModule.updateEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			publishedCommit: 'commit-bootstrap-skip-checks',
		}),
	)
})
