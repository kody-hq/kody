import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	listSavedPackagesPage: vi.fn(),
	getEntitySourceById: vi.fn(),
	readPublishedSourceSnapshot: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	listArtifactServerRefs: vi.fn(),
	confirmRemoteRefAtCommit: vi.fn(),
	listRepoSessionsBySource: vi.fn(),
	updateRepoSession: vi.fn(),
	finalizePublishedEntitySource: vi.fn(),
	syncWorkspaceFiles: vi.fn(),
	git: {
		init: vi.fn(),
		addRemote: vi.fn(),
		fetch: vi.fn(),
		readCommit: vi.fn(),
		branch: vi.fn(),
		checkout: vi.fn(),
		commit: vi.fn(),
		push: vi.fn(),
	},
	calls: [] as Array<string>,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesPage: (...args: Array<unknown>) =>
		mocks.listSavedPackagesPage(...args),
}))
vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readPublishedSourceSnapshot(...args),
}))
vi.mock('./artifacts.ts', () => ({
	buildArtifactsGitAuth: () => ({ username: 'x', password: 'redacted' }),
	buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) => remote,
	listArtifactServerRefs: (...args: Array<unknown>) =>
		mocks.listArtifactServerRefs(...args),
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mocks.resolveExistingArtifactSourceRepo(...args),
}))
vi.mock('./artifacts-git-retry.ts', () => ({
	runArtifactsGitWithRetry: (operation: () => Promise<unknown>) => operation(),
}))
vi.mock('./confirm-remote-ref.ts', () => ({
	toFullBranchRef: (ref: string) =>
		ref.startsWith('refs/') ? ref : `refs/heads/${ref}`,
	confirmRemoteRefAtCommit: (...args: Array<unknown>) =>
		mocks.confirmRemoteRefAtCommit(...args),
}))
vi.mock('./entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))
vi.mock('./ephemeral-git-workspace.ts', () => ({
	createEphemeralGitWorkspace: () => ({
		fs: {},
		dir: '/repo',
		filesystem: {},
	}),
}))
vi.mock('./external-publish.ts', () => ({
	finalizePublishedEntitySource: (...args: Array<unknown>) =>
		mocks.finalizePublishedEntitySource(...args),
}))
vi.mock('./isomorphic-git-lazy.ts', () => ({
	loadIsomorphicGit: async () => ({ git: mocks.git, http: {} }),
}))
vi.mock('./published-source-sync.ts', () => ({
	syncWorkspaceFiles: (...args: Array<unknown>) =>
		mocks.syncWorkspaceFiles(...args),
}))
vi.mock('./repo-sessions.ts', () => ({
	listRepoSessionsBySource: (...args: Array<unknown>) =>
		mocks.listRepoSessionsBySource(...args),
	updateRepoSession: (...args: Array<unknown>) =>
		mocks.updateRepoSession(...args),
}))

const { runPublishedCommitRefRepair, isPublishedCommitAdvertised } =
	await import('./published-commit-ref-repair.ts')

const ownerUserId = ownerIdFromStored('user-1')
const kvPut = vi.fn()
const env = {
	APP_DB: {},
	BUNDLE_ARTIFACTS_KV: { put: kvPut },
} as unknown as Env

const lostCommit = 'a'.repeat(40)
const priorCommit = 'b'.repeat(40)
const repairedCommit = 'c'.repeat(40)
const snapshotFiles = {
	'package.json': '{"name":"@scope/demo","version":"1.0.1"}',
	'src/index.ts': 'export default 1\n',
}

function savedPackage(id = 'package-1', sourceId = 'source-1') {
	return { id, userId: ownerUserId, sourceId }
}

function sourceRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'source-1',
		user_id: ownerUserId,
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: lostCommit,
		manifest_path: 'package.json',
		source_root: '/',
		...overrides,
	}
}

const rebuildArtifacts = vi.fn()

beforeEach(() => {
	vi.clearAllMocks()
	mocks.calls.length = 0
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: async () => ({
			remote: 'https://artifacts.test/repo-1.git',
			defaultBranch: 'main',
		}),
		createToken: async () => ({ plaintext: 'redacted' }),
	})
	mocks.listArtifactServerRefs.mockResolvedValue([
		{ ref: 'refs/heads/main', oid: priorCommit },
		{ ref: 'refs/heads/session-1', oid: priorCommit },
	])
	mocks.getEntitySourceById.mockResolvedValue(sourceRow())
	mocks.git.readCommit.mockRejectedValue(new Error('NotFoundError'))
	mocks.git.commit.mockResolvedValue(repairedCommit)
	mocks.readPublishedSourceSnapshot.mockResolvedValue({ files: snapshotFiles })
	mocks.listRepoSessionsBySource.mockResolvedValue([
		{
			id: 'session-1',
			user_id: ownerUserId,
			session_branch: 'session-1',
			base_commit: lostCommit,
			last_checkpoint_commit: lostCommit,
			status: 'published',
		},
		{
			id: 'session-old',
			user_id: ownerUserId,
			session_branch: 'session-old',
			base_commit: priorCommit,
			last_checkpoint_commit: priorCommit,
			status: 'published',
		},
	])
	kvPut.mockImplementation(async () => {
		mocks.calls.push('backup')
	})
	mocks.git.push.mockImplementation(
		async (args: { remoteRef: string; force?: boolean }) => {
			mocks.calls.push(`push:${args.remoteRef}:${args.force ? 'force' : 'ff'}`)
		},
	)
	mocks.confirmRemoteRefAtCommit.mockImplementation(
		async (args: { ref: string; commit: string }) => {
			mocks.calls.push(`confirm:${args.ref}:${args.commit}`)
		},
	)
	mocks.finalizePublishedEntitySource.mockImplementation(async () => {
		mocks.calls.push('finalize')
	})
	rebuildArtifacts.mockImplementation(async () => {
		mocks.calls.push('rebuild')
	})
})

test('isPublishedCommitAdvertised matches only real ref tips', () => {
	expect(
		isPublishedCommitAdvertised({
			refs: [{ ref: 'refs/heads/main', oid: lostCommit }],
			publishedCommit: lostCommit,
		}),
	).toBe(true)
	expect(
		isPublishedCommitAdvertised({
			refs: [{ ref: 'HEAD', oid: lostCommit }],
			publishedCommit: lostCommit,
		}),
	).toBe(false)
})

test('dry-run classifies packages without writing anything', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([
		savedPackage('pkg-advertised', 'src-advertised'),
		savedPackage('pkg-ancestor', 'src-ancestor'),
		savedPackage('pkg-lost', 'src-lost'),
		savedPackage('pkg-gone', 'src-gone'),
		savedPackage('pkg-draft', 'src-draft'),
	])
	mocks.getEntitySourceById.mockImplementation(
		async (_db: unknown, id: string) =>
			id === 'src-draft'
				? sourceRow({ id, published_commit: null })
				: sourceRow({ id }),
	)
	mocks.listArtifactServerRefs.mockImplementation(async () => [])
	let call = 0
	mocks.listArtifactServerRefs.mockImplementation(async () => {
		call += 1
		return call === 1
			? [{ ref: 'refs/heads/main', oid: lostCommit }]
			: [{ ref: 'refs/heads/main', oid: priorCommit }]
	})
	mocks.git.readCommit
		.mockResolvedValueOnce({ oid: lostCommit })
		.mockRejectedValue(new Error('NotFoundError'))
	mocks.readPublishedSourceSnapshot
		.mockResolvedValueOnce({ files: snapshotFiles })
		.mockResolvedValueOnce(null)

	const result = await runPublishedCommitRefRepair({
		env,
		baseUrl: 'https://kody.test',
		rebuildArtifacts,
	})

	expect(result).toMatchObject({
		dryRun: true,
		scannedPackages: 5,
		consistent: 2,
		repairable: 1,
		unrecoverable: 1,
		skippedUnpublished: 1,
		repaired: 0,
		failed: 0,
	})
	expect(result.outcomes.map((o) => [o.packageId, o.outcome])).toEqual([
		['pkg-lost', 'repairable'],
		['pkg-gone', 'unrecoverable'],
		['pkg-draft', 'skipped_unpublished'],
	])
	expect(kvPut).not.toHaveBeenCalled()
	expect(mocks.git.push).not.toHaveBeenCalled()
	expect(mocks.updateRepoSession).not.toHaveBeenCalled()
	expect(mocks.finalizePublishedEntitySource).not.toHaveBeenCalled()
})

test('apply requires explicit package ids', async () => {
	await expect(
		runPublishedCommitRefRepair({
			env,
			baseUrl: 'https://kody.test',
			dryRun: false,
			rebuildArtifacts,
		}),
	).rejects.toThrow('Apply requires explicit packageIds')
	expect(mocks.listSavedPackagesPage).not.toHaveBeenCalled()
})

test('apply backs up, fast-forwards with the snapshot tree, confirms refs, then moves pointers', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])

	const result = await runPublishedCommitRefRepair({
		env,
		baseUrl: 'https://kody.test',
		dryRun: false,
		packageIds: ['package-1'],
		rebuildArtifacts,
	})

	expect(result.repaired).toBe(1)
	expect(result.outcomes[0]).toMatchObject({
		outcome: 'repaired',
		repairedCommit,
		movedSessionIds: ['session-1'],
	})
	expect(mocks.calls).toEqual([
		'backup',
		'push:main:ff',
		`confirm:main:${repairedCommit}`,
		'push:session-1:force',
		`confirm:session-1:${repairedCommit}`,
		'finalize',
		'rebuild',
	])
	const backup = JSON.parse(kvPut.mock.calls[0]![1] as string)
	expect(backup).toMatchObject({
		source: { published_commit: lostCommit },
		defaultBranchHead: priorCommit,
		snapshotPublishedCommit: lostCommit,
	})
	expect(mocks.git.branch).toHaveBeenCalledWith(
		expect.objectContaining({ object: priorCommit }),
	)
	expect(mocks.syncWorkspaceFiles).toHaveBeenCalledWith(
		expect.objectContaining({ files: snapshotFiles }),
	)
	expect(mocks.updateRepoSession).toHaveBeenCalledTimes(1)
	expect(mocks.updateRepoSession).toHaveBeenCalledWith(env, {
		id: 'session-1',
		userId: ownerUserId,
		baseCommit: repairedCommit,
		lastCheckpointCommit: repairedCommit,
	})
	expect(mocks.finalizePublishedEntitySource).toHaveBeenCalledWith(
		expect.objectContaining({
			publishedCommit: repairedCommit,
			files: snapshotFiles,
			rebuildPackageArtifacts: false,
			allowLockedPublish: true,
		}),
	)
})

test('apply leaves published pointers alone when the repaired ref is not confirmed', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.confirmRemoteRefAtCommit.mockRejectedValueOnce(
		new Error('The source repo did not confirm the push'),
	)

	const result = await runPublishedCommitRefRepair({
		env,
		baseUrl: 'https://kody.test',
		dryRun: false,
		packageIds: ['package-1'],
		rebuildArtifacts,
	})

	expect(result.failed).toBe(1)
	expect(result.outcomes[0]?.error).toContain('did not confirm')
	expect(mocks.updateRepoSession).not.toHaveBeenCalled()
	expect(mocks.finalizePublishedEntitySource).not.toHaveBeenCalled()
	expect(rebuildArtifacts).not.toHaveBeenCalled()
})

test('apply refuses to advance published_commit if it moved during repair', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.getEntitySourceById
		.mockResolvedValueOnce(sourceRow())
		.mockResolvedValueOnce(sourceRow({ published_commit: 'd'.repeat(40) }))

	const result = await runPublishedCommitRefRepair({
		env,
		baseUrl: 'https://kody.test',
		dryRun: false,
		packageIds: ['package-1'],
		rebuildArtifacts,
	})

	expect(result.failed).toBe(1)
	expect(result.outcomes[0]?.error).toContain('published_commit moved')
	expect(mocks.finalizePublishedEntitySource).not.toHaveBeenCalled()
})

test('apply never repairs a package whose published commit is reachable', async () => {
	mocks.listSavedPackagesPage.mockResolvedValueOnce([savedPackage()])
	mocks.git.readCommit.mockResolvedValue({ oid: lostCommit })

	const result = await runPublishedCommitRefRepair({
		env,
		baseUrl: 'https://kody.test',
		dryRun: false,
		packageIds: ['package-1'],
		rebuildArtifacts,
	})

	expect(result).toMatchObject({ consistent: 1, repaired: 0 })
	expect(kvPut).not.toHaveBeenCalled()
	expect(mocks.git.push).not.toHaveBeenCalled()
})
