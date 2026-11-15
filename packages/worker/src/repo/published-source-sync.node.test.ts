import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as ExternalPublish from './external-publish.ts'
import type * as PublishGitNotes from './publish-git-notes.ts'

const mockModule = vi.hoisted(() => ({
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceRepo: vi.fn(),
	finalizePublishedEntitySource: vi.fn<
		typeof ExternalPublish.finalizePublishedEntitySource
	>(async () => undefined),
	writeArtifactSourceSnapshot: vi.fn(async () => ({
		published_commit: 'commit-loopback-1',
		files: {} as Record<string, string>,
	})),
	attachPublishGitNoteBestEffort: vi.fn(async () => undefined),
	buildPublishGitNote: vi.fn(
		(input: Parameters<typeof PublishGitNotes.buildPublishGitNote>[0]) => ({
			v: 1 as const,
			publishedAt: '2026-10-12T00:00:00.000Z',
			publishedBy: input.publishedBy,
			sourceId: input.source.id,
			entityKind: input.source.entity_kind,
			entityId: input.source.entity_id,
			repoId: input.source.repo_id,
			commit: input.commit,
		}),
	),
	loopback: false,
	hasArtifactsAccess: () => true,
	git: {
		init: vi.fn(async () => undefined),
		addRemote: vi.fn(async () => undefined),
		fetch: vi.fn(async () => undefined),
		checkout: vi.fn(async () => undefined),
		listFiles: vi.fn(async () => ['package.json']),
		remove: vi.fn(async () => undefined),
		add: vi.fn(async () => undefined),
		statusMatrix: vi.fn(
			async () =>
				[['package.json', 1, 2, 2]] as Array<[string, number, number, number]>,
		),
		commit: vi.fn(async () => 'commit-new-published'),
		branch: vi.fn(async () => undefined),
		push: vi.fn(async (_input: Record<string, unknown>) => undefined),
		resolveRef: vi.fn(async () => 'commit-remote-tip'),
		isDescendent: vi.fn(async () => false),
	},
	http: {},
	ephemeralFs: {
		writeFileBytes: vi.fn(async () => undefined),
		mkdir: vi.fn(async () => undefined),
		rm: vi.fn(async () => undefined),
	},
	ephemeralWorkspaceFs: {},
}))

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('./artifacts.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./artifacts.ts')>()
	return {
		...actual,
		hasArtifactsAccess: () => mockModule.hasArtifactsAccess(),
		isSnapshotOnlyArtifactsRemote: (_env?: unknown, _remote?: string) =>
			mockModule.loopback,
		resolveArtifactSourceRepo: (...args: Array<unknown>) =>
			mockModule.resolveArtifactSourceRepo(...args),
		buildArtifactsGitAuth: () => ({ username: 'x', password: 'token' }),
		buildAuthenticatedArtifactsRemote: (input: { remote: string }) =>
			input.remote,
	}
})

vi.mock('./artifact-source-snapshot.ts', () => ({
	writeArtifactSourceSnapshot: mockModule.writeArtifactSourceSnapshot,
}))

vi.mock('./external-publish.ts', () => ({
	finalizePublishedEntitySource: (
		...args: Parameters<typeof ExternalPublish.finalizePublishedEntitySource>
	) => mockModule.finalizePublishedEntitySource(...args),
}))

vi.mock('./publish-git-notes.ts', () => ({
	attachPublishGitNoteBestEffort: mockModule.attachPublishGitNoteBestEffort,
	buildPublishGitNote: mockModule.buildPublishGitNote,
}))

vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({
		git: mockModule.git,
		http: mockModule.http,
		createGit: vi.fn(),
	}),
}))

vi.mock('./ephemeral-git-workspace.ts', () => ({
	createEphemeralGitWorkspace: () => ({
		fs: mockModule.ephemeralWorkspaceFs,
		filesystem: mockModule.ephemeralFs,
		dir: '/repo',
	}),
}))

vi.mock('./artifacts-git-retry.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('./artifacts-git-retry.ts')>()
	return {
		...actual,
		runArtifactsGitWithRetry: async <T>(fn: () => Promise<T>) => fn(),
		wrapArtifactsGitHttpError: (input: {
			operation: string
			error: unknown
		}) =>
			input.error instanceof Error
				? input.error
				: new Error(String(input.error)),
	}
})

const {
	kodyPublishedBranchName,
	kodyPublishedRef,
	syncPublishedSourceSnapshotOnly,
} = await import('./published-source-sync.ts')

const sourceRow = {
	id: 'source-1',
	user_id: ownerIdFromStored('user-1'),
	entity_kind: 'package' as const,
	entity_id: 'pkg-1',
	repo_id: 'repo-1',
	published_commit: 'commit-published',
	indexed_commit: 'commit-published',
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-10-01T00:00:00.000Z',
	updated_at: '2026-10-01T00:00:00.000Z',
}

function createEnv() {
	return {
		APP_DB: { prepare: () => ({}) } as unknown as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
	} as Env
}

function setupRepoAccess(remote = 'https://artifacts.example/git/repo-1.git') {
	mockModule.resolveArtifactSourceRepo.mockResolvedValue({
		info: async () => ({ remote, defaultBranch: 'main' }),
		createToken: async () => ({ plaintext: 'art_token' }),
	})
}

test('syncPublishedSourceSnapshotOnly pushes kody-published and finalizes without touching default branch', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow)
	setupRepoAccess()
	mockModule.loopback = false
	mockModule.git.push.mockClear()
	mockModule.finalizePublishedEntitySource.mockClear()

	const commit = await syncPublishedSourceSnapshotOnly({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://kody.codes',
		sourceId: 'source-1',
		files: { 'package.json': '{"name":"@user/pkg"}\n' },
		expectedPublishedCommit: 'commit-published',
		commitMessage: 'codemod(0012): add url-secret verification',
	})

	expect(commit).toBe('commit-new-published')
	expect(mockModule.git.branch).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: kodyPublishedBranchName,
			object: 'commit-new-published',
			force: true,
		}),
	)
	expect(mockModule.git.push).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: kodyPublishedBranchName,
			remoteRef: kodyPublishedRef,
		}),
	)
	const pushArgs = mockModule.git.push.mock.calls[0]
	expect(pushArgs?.[0]).toEqual(
		expect.objectContaining({
			ref: kodyPublishedBranchName,
			remoteRef: kodyPublishedRef,
		}),
	)
	expect(pushArgs?.[0]).not.toEqual(expect.objectContaining({ ref: 'main' }))
	expect(pushArgs?.[0]).not.toEqual(
		expect.objectContaining({ remoteRef: 'refs/heads/main' }),
	)
	expect(mockModule.finalizePublishedEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({
			publishedCommit: 'commit-new-published',
			source: sourceRow,
		}),
	)
})

test('syncPublishedSourceSnapshotOnly with promotePublished false skips finalize', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow)
	setupRepoAccess()
	mockModule.loopback = false
	mockModule.finalizePublishedEntitySource.mockClear()

	const commit = await syncPublishedSourceSnapshotOnly({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://kody.codes',
		sourceId: 'source-1',
		files: { 'package.json': '{"name":"@user/pkg"}\n' },
		expectedPublishedCommit: 'commit-published',
		commitMessage: 'codemod(0012): pending locked',
		promotePublished: false,
	})

	expect(commit).toBe('commit-new-published')
	expect(mockModule.git.push).toHaveBeenCalled()
	expect(mockModule.finalizePublishedEntitySource).not.toHaveBeenCalled()
})

test('syncPublishedSourceSnapshotOnly loopback path finalizes without git push', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow)
	setupRepoAccess('http://127.0.0.1:8787/git/repo-1.git')
	mockModule.loopback = true
	mockModule.git.push.mockClear()
	mockModule.finalizePublishedEntitySource.mockClear()

	const commit = await syncPublishedSourceSnapshotOnly({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'http://localhost:3742',
		sourceId: 'source-1',
		files: { 'package.json': '{"name":"@user/pkg"}\n' },
		expectedPublishedCommit: 'commit-published',
		commitMessage: 'codemod(0012): loopback',
	})

	expect(commit).toBe('commit-loopback-1')
	expect(mockModule.git.push).not.toHaveBeenCalled()
	expect(mockModule.finalizePublishedEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'commit-loopback-1' }),
	)
})

test('syncPublishedSourceSnapshotOnly refuses ownership mismatch', async () => {
	mockModule.getEntitySourceById.mockResolvedValue({
		...sourceRow,
		user_id: ownerIdFromStored('user-other'),
	})
	await expect(
		syncPublishedSourceSnapshotOnly({
			env: createEnv(),
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://kody.codes',
			sourceId: 'source-1',
			files: { 'package.json': '{}\n' },
			expectedPublishedCommit: 'commit-published',
			commitMessage: 'codemod(0012): nope',
		}),
	).rejects.toThrow(/ownership mismatch/i)
})

test('syncPublishedSourceSnapshotOnly refuses when published_commit moved', async () => {
	mockModule.getEntitySourceById.mockResolvedValue({
		...sourceRow,
		published_commit: 'commit-owner-just-published',
	})
	await expect(
		syncPublishedSourceSnapshotOnly({
			env: createEnv(),
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://kody.codes',
			sourceId: 'source-1',
			files: { 'package.json': '{}\n' },
			expectedPublishedCommit: 'commit-published',
			commitMessage: 'codemod(0012): race',
		}),
	).rejects.toThrow(/published commit moved/i)
})

test('syncPublishedSourceSnapshotOnly force-pushes leftover tips when published_commit is unchanged', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow)
	setupRepoAccess()
	mockModule.loopback = false
	mockModule.git.push.mockReset()
	mockModule.git.push
		.mockRejectedValueOnce(new Error('non-fast-forward'))
		.mockResolvedValueOnce(undefined)
	// Leftover tip after a prior push that never finalized (descendant of expected).
	mockModule.git.resolveRef.mockResolvedValue('commit-leftover-tip')

	const commit = await syncPublishedSourceSnapshotOnly({
		env: createEnv(),
		userId: ownerIdFromStored('user-1'),
		baseUrl: 'https://kody.codes',
		sourceId: 'source-1',
		files: { 'package.json': '{"name":"@user/pkg"}\n' },
		expectedPublishedCommit: 'commit-published',
		commitMessage: 'codemod(0012): recover leftover',
	})

	expect(commit).toBe('commit-new-published')
	expect(mockModule.git.push).toHaveBeenCalledTimes(2)
	expect(mockModule.git.push.mock.calls[1]?.[0]).toEqual(
		expect.objectContaining({ force: true }),
	)
	// Re-read published_commit on NFF (initial load + race check).
	expect(
		mockModule.getEntitySourceById.mock.calls.length,
	).toBeGreaterThanOrEqual(2)
})

test('syncPublishedSourceSnapshotOnly refuses force-push when published_commit moved', async () => {
	mockModule.getEntitySourceById
		.mockResolvedValueOnce(sourceRow)
		.mockResolvedValueOnce({
			...sourceRow,
			published_commit: 'commit-concurrent-winner',
		})
	setupRepoAccess()
	mockModule.loopback = false
	mockModule.git.push.mockReset()
	mockModule.git.push.mockRejectedValueOnce(new Error('non-fast-forward'))
	mockModule.git.resolveRef.mockResolvedValue('commit-concurrent-winner')

	await expect(
		syncPublishedSourceSnapshotOnly({
			env: createEnv(),
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://kody.codes',
			sourceId: 'source-1',
			files: { 'package.json': '{"name":"@user/pkg"}\n' },
			expectedPublishedCommit: 'commit-published',
			commitMessage: 'codemod(0012): concurrent finalize',
		}),
	).rejects.toThrow(/concurrent published-only update/i)

	expect(mockModule.git.push).toHaveBeenCalledTimes(1)
	expect(mockModule.git.push.mock.calls[0]?.[0]).not.toEqual(
		expect.objectContaining({ force: true }),
	)
})
