// RepoSession.runIsolatedAuthoringChecks: the throwaway check isolate that
// packageCheck (kody dev check) uses so the publish checks never run in the
// shared origin request isolate. Mock setup mirrors repo-session-do.node.test.ts.

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
import type * as CredentialNeedsApproval from '#worker/credentials/credential-needs-approval.ts'
import type * as StorageBuckets from '#worker/storage-buckets/service.ts'
import {
	repoSessionMockModule as mockModule,
	publishedBundleArtifactsRepoSessionMocks,
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

vi.mock('./checks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof Checks>()
	return {
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
		createSnapshotFilesWorkspace: actual.createSnapshotFilesWorkspace,
	}
})

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

function repoSession(
	env: Env = createEnv(),
	state = createDurableObjectState(),
) {
	return new RepoSession(state, env)
}

function kvEnv(kv: unknown = {}) {
	return { APP_DB: {}, BUNDLE_ARTIFACTS_KV: kv } as unknown as Env
}

test('isolated authoring checks run the publish checks on staged files and reject expired or cross-user staging keys', async () => {
	restoreRepoSessionMockBaseline()
	const staged = { sourceFiles: { 'package.json': '{"name":"@kody/demo"}' } }
	const kv = { get: vi.fn(async () => staged) }
	const repo = repoSession(kvEnv(kv))
	mockModule.runRepoChecks.mockResolvedValueOnce({
		ok: false,
		results: [
			{ kind: 'manifest', ok: true, message: 'Validated package.json.' },
			{ kind: 'lint', ok: false, message: 'Lint failed.' },
		],
		manifest: null,
		sourceFiles: {},
	})
	await expect(
		repo.runIsolatedAuthoringChecks({
			stagingKey: 'repo-checks-staging:v1:user-1:abc',
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://kody.test',
			sourceId: 'source-1',
			expectedPackageScope: 'kody',
		}),
	).resolves.toEqual({
		ok: false,
		results: [
			{ kind: 'manifest', ok: true, message: 'Validated package.json.' },
			{ kind: 'lint', ok: false, message: 'Lint failed.' },
		],
	})
	expect(mockModule.runRepoChecks).toHaveBeenLastCalledWith(
		expect.objectContaining({
			manifestPath: 'package.json',
			sourceRoot: '/',
			baseUrl: 'https://kody.test',
			userId: ownerIdFromStored('user-1'),
			sourceId: 'source-1',
			expectedPackageScope: 'kody',
		}),
	)

	const [{ workspace }] = mockModule.runRepoChecks.mock.lastCall as [
		{ workspace: { readFile(path: string): Promise<string | null> } },
	]
	await expect(workspace.readFile('package.json')).resolves.toBe(
		staged.sourceFiles['package.json'],
	)

	const callsBefore = mockModule.runRepoChecks.mock.calls.length
	await expect(
		repo.runIsolatedAuthoringChecks({
			stagingKey: 'repo-checks-staging:v1:user-2:abc',
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://kody.test',
		}),
	).resolves.toMatchObject({
		ok: false,
		results: [{ message: expect.stringMatching(/does not belong/) }],
	})
	kv.get.mockResolvedValueOnce(null as never)
	await expect(
		repo.runIsolatedAuthoringChecks({
			stagingKey: 'repo-checks-staging:v1:user-1:gone',
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://kody.test',
		}),
	).resolves.toMatchObject({
		ok: false,
		results: [{ message: expect.stringMatching(/expired or is missing/) }],
	})
	expect(mockModule.runRepoChecks.mock.calls.length).toBe(callsBefore)
})

test('isolated authoring checks expose staged binary files by path and size', async () => {
	restoreRepoSessionMockBaseline()
	const staged = {
		sourceFiles: { 'package.json': '{"name":"@kody/demo"}' },
		binaryFileSizes: { 'icons/icon-192.png': 52_126 },
	}
	const repo = repoSession(kvEnv({ get: vi.fn(async () => staged) }))
	mockModule.runRepoChecks.mockResolvedValueOnce({
		ok: false,
		results: [],
		manifest: null,
		sourceFiles: {},
	})
	await repo.runIsolatedAuthoringChecks({
		stagingKey: 'repo-checks-staging:v1:user-1:abc',
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://kody.test',
	})
	const [{ workspace }] = mockModule.runRepoChecks.mock.lastCall as [
		{
			workspace: {
				readFile(path: string): Promise<string | null>
				stat(path: string): Promise<{ size: number } | null>
				glob(pattern: string): Promise<Array<{ path: string }>>
			}
		},
	]
	expect((await workspace.glob('**/*')).map((file) => file.path)).toEqual([
		'package.json',
		'icons/icon-192.png',
	])
	await expect(workspace.readFile('icons/icon-192.png')).resolves.toBe('')
	await expect(workspace.stat('icons/icon-192.png')).resolves.toEqual({
		size: 52_126,
	})
	await expect(workspace.stat('package.json')).resolves.toBeNull()
})
