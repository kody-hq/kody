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
import { type PublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
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

const demoPackageJson =
	'{"name":"@kody/demo","exports":{".":"./index.ts"},"kody":{"id":"demo","description":"Demo"}}'

function kvEnv(kv: unknown = {}) {
	return { APP_DB: {}, BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
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
