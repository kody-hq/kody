import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createWorkspaceStateBackend, type Workspace } from '@cloudflare/shell'
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
import {
	repoSessionMockModule as mockModule,
	publishedBundleArtifactsRepoSessionMocks,
	createDurableObjectState,
	createEnv,
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
		...publishedBundleArtifactsRepoSessionMocks(mockModule),
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

const session = { sessionId: 'session-1', userId: ownerIdFromStored('user-1') }

function repoSession(
	env: Env = createEnv(),
	state = createDurableObjectState(),
) {
	return new RepoSession(state, env)
}

function lastWorkspaceBackend() {
	return vi.mocked(createWorkspaceStateBackend).mock.results.at(-1)?.value as {
		applyEditPlan: ReturnType<typeof vi.fn>
	}
}

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
