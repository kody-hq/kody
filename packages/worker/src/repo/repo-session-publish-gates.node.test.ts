import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createWorkspaceStateBackend, type Workspace } from '@cloudflare/shell'
import type git from 'isomorphic-git'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as Artifacts from './artifacts.ts'
import type * as Checks from './checks.ts'
import type * as EntitySources from './entity-sources.ts'
import type * as ExternalPublishClone from './external-publish-clone.ts'
import type * as RepoSessions from './repo-sessions.ts'
import type * as PublishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import type { PublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import type * as SavedPackageRepo from '#worker/package-registry/repo.ts'
import type * as CredentialNeedsApproval from '#worker/credentials/credential-needs-approval.ts'
import { recordPackageAppPublisherUnknown } from '#worker/package-runtime/package-app-authority.ts'
import type * as StorageBuckets from '#worker/storage-buckets/service.ts'
import {
	repoSessionMockModule as mockModule,
	publishedBundleArtifactsRepoSessionMocks,
	restoreRepoSessionMockBaseline,
	checkedPublishState,
	createDurableObjectState,
	createEnv,
	sessionRow,
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

const { RepoSession } = await import('./repo-session-do.ts')

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

function lastWorkspaceBackend() {
	return vi.mocked(createWorkspaceStateBackend).mock.results.at(-1)?.value as {
		applyEditPlan: ReturnType<typeof vi.fn>
	}
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

test('applyEdits rejects write, replace, and writeJson targets that are directories', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceStat.mockImplementation(async (path: string) =>
		path === '/session/src'
			? {
					path: '/session/src',
					name: 'src',
					type: 'directory' as const,
					mimeType: 'inode/directory',
					size: 0,
					createdAt: 0,
					updatedAt: 0,
				}
			: null,
	)
	const repo = repoSession()
	const directoryMessage =
		/repo session (write|replace|writeJson) edit target "src" is a directory\. Pass a file path/

	await expect(
		repo.applyEdits({
			...session,
			edits: [{ kind: 'write', path: 'src', content: 'export {}\n' }],
		}),
	).rejects.toThrow(directoryMessage)
	await expect(
		repo.applyEdits({
			...session,
			edits: [
				{
					kind: 'replace',
					path: 'src',
					search: 'a',
					replacement: 'b',
				},
			],
		}),
	).rejects.toThrow(directoryMessage)
	await expect(
		repo.applyEdits({
			...session,
			edits: [{ kind: 'writeJson', path: 'src', value: { ok: true } }],
		}),
	).rejects.toThrow(directoryMessage)
	expect(lastWorkspaceBackend().applyEditPlan).not.toHaveBeenCalled()
})

test('applyEdits remaps raw Cloudflare shell EISDIR from applyEditPlan', async () => {
	setCommonSessionFixtures()
	vi.mocked(createWorkspaceStateBackend).mockImplementationOnce(
		() =>
			({
				planEdits: vi.fn(),
				applyEditPlan: vi.fn(async () => {
					throw new Error('EISDIR: /session/src is a directory')
				}),
				walkTree: vi.fn(),
			}) as unknown as ReturnType<typeof createWorkspaceStateBackend>,
	)

	// Preflight passes (stat is null); the shell still throws EISDIR — remap
	// so callers never see the raw filesystem error. KODY-A6.
	await expect(
		repoSession().applyEdits({
			...session,
			edits: [
				{
					kind: 'write',
					path: 'src/index.ts',
					content: 'export {}\n',
				},
			],
		}),
	).rejects.toThrow(
		'repo session write edit target "src" is a directory. Pass a file path (for example src/index.ts), not a folder.',
	)
})

test('applyEdits EISDIR remap uses the failing path kind in a multi-edit plan', async () => {
	setCommonSessionFixtures()
	vi.mocked(createWorkspaceStateBackend).mockImplementationOnce(
		() =>
			({
				planEdits: vi.fn(),
				applyEditPlan: vi.fn(async () => {
					throw new Error('EISDIR: /session/src/my file.ts is a directory')
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
					path: 'readme.md',
					content: '# hi\n',
				},
				{
					kind: 'replace',
					path: 'src/my file.ts',
					search: 'a',
					replacement: 'b',
				},
			],
		}),
	).rejects.toThrow(
		'repo session replace edit target "src/my file.ts" is a directory. Pass a file path (for example src/index.ts), not a folder.',
	)
})

test('readFile remaps raw Cloudflare shell EISDIR for a folder path (KODY-CA)', async () => {
	setCommonSessionFixtures()
	const fallbackReadFile = mockModule.workspaceReadFile.getMockImplementation()
	mockModule.workspaceReadFile.mockImplementation(async (path: string) => {
		if (path === '/session/src') {
			throw new Error('EISDIR: /session/src is a directory')
		}
		return fallbackReadFile ? fallbackReadFile(path) : null
	})
	const repo = repoSession()

	await expect(repo.readFile({ ...session, path: 'src' })).rejects.toThrow(
		'repo session read target "src" is a directory. Pass a file path (for example src/index.ts), or use repoTree to list the folder.',
	)
	await expect(repo.readFile({ ...session, path: 'src' })).rejects.not.toThrow(
		/EISDIR/,
	)
})

test('readFile keeps non-EISDIR workspace failures unchanged', async () => {
	setCommonSessionFixtures()
	mockModule.workspaceReadFile.mockImplementation(async () => {
		throw new Error('SQLITE_BUSY: database is locked')
	})

	await expect(
		repoSession().readFile({ ...session, path: 'src/index.ts' }),
	).rejects.toThrow('SQLITE_BUSY: database is locked')
})

test('published artifact rebuild rejects when a concurrent publish moves the commit between check and persist', async () => {
	const commitA = 'commit-a'
	const commitB = 'commit-b'
	const filesA = {
		'package.json': demoPackageJson,
		'index.ts': 'export const fromA = true\n',
	}
	const filesB = {
		'package.json': demoPackageJson,
		'index.ts': 'export const fromB = true\n',
	}
	const target = {
		kind: 'module' as const,
		artifactName: '.',
		entryPoint: 'index.ts',
		bundleKind: 'module' as const,
	}

	// Staging for A while the source already points at B must fail — never
	// stage B's snapshot under an A rebuild request.
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById.mockResolvedValue(
		sourceRow({ published_commit: commitB }),
	)
	mockModule.loadPublishedSourceSnapshot.mockImplementation(
		async (input: { source: { published_commit: string | null } }) => {
			if (input.source.published_commit === commitA) {
				return publishedSnapshot(filesA, { publishedCommit: commitA })
			}
			if (input.source.published_commit === commitB) {
				return publishedSnapshot(filesB, { publishedCommit: commitB })
			}
			return null
		},
	)
	await expect(
		repoSession(
			kvEnv({ put: vi.fn(async () => undefined) }),
		).stagePublishedPackageArtifactRebuild({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			publishedCommit: commitA,
		}),
	).rejects.toThrow(/Published commit changed from "commit-a" to "commit-b"/)
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).not.toHaveBeenCalled()

	// Stage succeeds at A, then a concurrent publish moves the source to B
	// before persist — isolated rebuild must fail and must not write.
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(sourceRow({ published_commit: commitA }))
		.mockResolvedValue(sourceRow({ published_commit: commitB }))
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(filesA, { publishedCommit: commitA }),
	)
	const put = vi.fn(
		async (_key: string, _body: string, _options: unknown) => undefined,
	)
	const staged = await repoSession(
		kvEnv({ put }),
	).stagePublishedPackageArtifactRebuild({
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		publishedCommit: commitA,
	})
	const stagedBody = put.mock.calls[0]?.[1]
	expect(typeof stagedBody).toBe('string')
	const stagedPayload = JSON.parse(stagedBody as string) as {
		sourceFiles: Record<string, string>
		publishedCommit: string
	}
	expect(stagedPayload).toEqual({
		sourceFiles: filesA,
		publishedCommit: commitA,
	})

	const rebuildKv = {
		get: vi.fn(async () => stagedPayload),
		put: vi.fn(async () => undefined),
	}
	const outcome = await repoSession(
		kvEnv(rebuildKv),
	).runIsolatedArtifactRebuild({
		stagingKey: staged.stagingKey,
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		publishedCommit: commitA,
		targets: [target],
		baseUrl: 'https://kody.test',
	})
	expect(outcome.ok).toBe(false)
	expect(outcome.message).toMatch(
		/Published commit changed from "commit-a" to "commit-b"/,
	)
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).not.toHaveBeenCalled()

	// Non-isolated rebuild path: collection sees A, then persist re-check sees B.
	restoreRepoSessionMockBaseline()
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(sourceRow({ published_commit: commitA }))
		.mockResolvedValue(sourceRow({ published_commit: commitB }))
	mockModule.loadPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot(filesA, { publishedCommit: commitA }),
	)
	await expect(
		repoSession(kvEnv()).rebuildPublishedPackageArtifact({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			publishedCommit: commitA,
			target,
			baseUrl: 'https://kody.test',
		}),
	).rejects.toThrow(/Published commit changed from "commit-a" to "commit-b"/)
	expect(
		mockModule.persistPublishedPackageArtifactTarget,
	).not.toHaveBeenCalled()
})

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

test('a session publish with no known person clears the publisher; a platform rewrite leaves it alone', async () => {
	consoleWarn.mockImplementation(() => {})
	const packageFile = { 'package.json': userPackageJson }
	for (const [requestedByUserId, clears] of [
		[undefined, false],
		[null, true],
	] as const) {
		vi.mocked(recordPackageAppPublisherUnknown).mockClear()
		setCommonSessionFixtures()
		seedWorkspace(packageFile)
		const state = await checkedPublishState(packageFile)
		await expect(
			repoSession(createEnv(), state).publishSession({
				...session,
				...(requestedByUserId === undefined ? {} : { requestedByUserId }),
			}),
		).resolves.toMatchObject({ status: 'ok' })
		expect(vi.mocked(recordPackageAppPublisherUnknown).mock.calls.length).toBe(
			clears ? 1 : 0,
		)
	}
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

test('publishSession does not report success or move published pointers when the source ref never shows the pushed commit', async () => {
	consoleWarn.mockImplementation(() => {})
	setCommonSessionFixtures()
	mockModule.gitState.headCommit = 'commit-session-head'
	mockModule.gitState.statusEntries = [{ status: 'modified' }]
	// The push call reports success, but the remote ref never moves (the
	// failure mode where Artifacts acknowledged a push that did not land).
	mockModule.gitState.remoteRefs.set('refs/heads/main', 'commit-base')
	mockModule.rawPush.mockImplementation(async () => ({
		ok: true,
		error: null,
		refs: {},
	}))
	const packageFile = { 'package.json': userPackageJson }
	seedWorkspace(packageFile)
	const state = await checkedPublishState(packageFile)

	vi.useFakeTimers()
	try {
		let settled = false
		const publishSession = repoSession(createEnv(), state)
			.publishSession(session)
			.then(
				() => {
					settled = true
					return null
				},
				(caught: unknown) => {
					settled = true
					return caught
				},
			)
		await vi.waitFor(
			() => {
				if (!settled) throw new Error('publishSession still pending')
			},
			{ timeout: 15_000, interval: 250 },
		)
		const error = await publishSession

		expect(error).toBeInstanceOf(Error)
		expect((error as Error).name).toBe('RemoteRefNotConfirmedError')
		expect((error as Error).message).toContain(
			'refs/heads/main is at commit-base, expected commit-session-head',
		)
		expect(mockModule.listArtifactServerRefs).toHaveBeenCalledWith(
			expect.objectContaining({ prefix: 'refs/heads/main' }),
		)
		// Nothing advanced: no published snapshot, no D1 pointer, no session
		// base/checkpoint/published move, and session scratch is kept for retry.
		expect(mockModule.writePublishedSourceSnapshot).not.toHaveBeenCalled()
		expect(mockModule.updateEntitySource).not.toHaveBeenCalled()
		expect(mockModule.updateRepoSession).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ status: 'published' }),
		)
		expect(mockModule.updateRepoSession).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ baseCommit: 'commit-session-head' }),
		)
		expect(mockModule.deleteStorageBucketInventory).not.toHaveBeenCalled()
	} finally {
		vi.useRealTimers()
	}
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

test('getSessionInfo skips workspace clone for published sessions', async () => {
	setCommonSessionFixtures()
	mockModule.getRepoSessionById.mockResolvedValue(
		sessionRow({
			id: 'session-1',
			status: 'published',
			expires_at: '2026-11-01T00:00:00.000Z',
		}),
	)
	mockModule.storageBucketInventoryExists.mockResolvedValueOnce(true)
	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.git.clone.mockClear()
	await expect(repoSession().getSessionInfo(session)).resolves.toMatchObject({
		id: 'session-1',
	})
	expect(mockModule.git.clone).not.toHaveBeenCalled()
	expect(mockModule.deleteStorageBucketInventory).toHaveBeenCalled()
})

test('listPublishedPackageArtifactTargets skips clone for published sessions', async () => {
	setCommonSessionFixtures()
	mockModule.getRepoSessionById.mockResolvedValue(
		sessionRow({
			id: 'session-1',
			status: 'published',
			expires_at: '2026-11-01T00:00:00.000Z',
		}),
	)
	mockModule.loadPublishedSourceManifestSnapshot.mockResolvedValue({
		version: 1,
		sourceId: 'source-1',
		publishedCommit: 'commit-base',
		manifestPath: 'package.json',
		manifestContent: userPackageJson,
		createdAt: '2026-08-17T20:00:00.000Z',
	})
	mockModule.workspaceExists.mockResolvedValue(false)
	mockModule.git.clone.mockClear()
	await expect(
		repoSession().listPublishedPackageArtifactTargets(session),
	).resolves.toEqual(
		expect.arrayContaining([
			expect.objectContaining({ artifactName: '.', kind: 'module' }),
		]),
	)
	expect(mockModule.git.clone).not.toHaveBeenCalled()
})
