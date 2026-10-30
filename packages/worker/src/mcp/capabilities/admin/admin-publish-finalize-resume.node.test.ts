import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { adminPublishFinalizeResumeCapability } from './admin-publish-finalize-resume.ts'

const mocks = vi.hoisted(() => ({
	getSavedPackageByIdInAnyOrg: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishedPublishChecksAreCurrent: vi.fn(),
	listJobsForUser: vi.fn(),
	readPublishGitNoteFromArtifactsRepo: vi.fn(),
	publishFromExternalRef: vi.fn(),
	rebuildPublishedPackageArtifactsViaRepoSession: vi.fn(),
	countUnbuiltPublishedPackageArtifactTargets: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: (...args: Array<unknown>) =>
		mocks.getSavedPackageByIdInAnyOrg(...args),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mocks.getEntitySourceById(...args),
}))
vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: (...args: Array<unknown>) =>
		mocks.resolveArtifactSourceHead(...args),
}))
vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	publishedPublishChecksAreCurrent: (...args: Array<unknown>) =>
		mocks.publishedPublishChecksAreCurrent(...args),
}))
vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		listJobsForUser: (...args: Array<unknown>) =>
			mocks.listJobsForUser(...args),
	}),
}))
vi.mock('#worker/repo/publish-git-notes.ts', () => ({
	readPublishGitNoteFromArtifactsRepo: (...args: Array<unknown>) =>
		mocks.readPublishGitNoteFromArtifactsRepo(...args),
}))
vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: (...args: Array<unknown>) =>
			mocks.publishFromExternalRef(...args),
	}),
}))
vi.mock('#mcp/capabilities/repo/package-artifact-rebuild.ts', () => ({
	rebuildPublishedPackageArtifactsViaRepoSession: (...args: Array<unknown>) =>
		mocks.rebuildPublishedPackageArtifactsViaRepoSession(...args),
	countUnbuiltPublishedPackageArtifactTargets: (...args: Array<unknown>) =>
		mocks.countUnbuiltPublishedPackageArtifactTargets(...args),
}))

function createContext(roles: Array<string>) {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('actor-1'),
				username: 'actor',
				email: 'actor@example.com',
				displayName: 'Actor',
				roles,
			},
		}),
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getSavedPackageByIdInAnyOrg.mockResolvedValue({
		id: 'package-1',
		userId: 'owner-1',
		sourceId: 'source-1',
	})
	mocks.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'owner-1',
		entity_kind: 'package',
		repo_id: 'repo-1',
		published_commit: 'commit-new',
	})
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-new',
	})
	mocks.publishedPublishChecksAreCurrent.mockResolvedValue(false)
	mocks.listJobsForUser.mockResolvedValue([
		{ source_id: 'source-1', record: { publishedCommit: 'commit-old' } },
		{ source_id: 'source-other', record: { publishedCommit: 'commit-x' } },
	])
	mocks.readPublishGitNoteFromArtifactsRepo.mockResolvedValue({ found: false })
	mocks.countUnbuiltPublishedPackageArtifactTargets.mockResolvedValue({
		targetCount: 3,
		unbuiltCount: 3,
	})
	mocks.publishFromExternalRef.mockResolvedValue({
		status: 'already_published',
		published_commit: 'commit-new',
		checks_rerun: true,
	})
	mocks.rebuildPublishedPackageArtifactsViaRepoSession.mockResolvedValue({
		rebuiltTargetCount: 3,
	})
})

test('requires admin and defaults to a dry-run report of the interrupted publish', async () => {
	await expect(
		adminPublishFinalizeResumeCapability.handler(
			{ packageIds: ['package-1'] },
			createContext(['user']),
		),
	).rejects.toThrow('lacks required role "admin"')

	await expect(
		adminPublishFinalizeResumeCapability.handler(
			{ packageIds: ['package-1'] },
			createContext(['admin']),
		),
	).resolves.toEqual({
		dryRun: true,
		outcomes: [
			{
				packageId: 'package-1',
				ownerUserId: 'owner-1',
				sourceId: 'source-1',
				publishedCommit: 'commit-new',
				outcome: 'incomplete',
				sealed: false,
				staleJobCount: 1,
				publishNoteFound: false,
				unbuiltArtifactTargetCount: 3,
			},
		],
	})
	expect(mocks.publishFromExternalRef).not.toHaveBeenCalled()
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).not.toHaveBeenCalled()
})

test('apply finishes the live commit and rebuilds its artifacts without moving the source', async () => {
	const result = await adminPublishFinalizeResumeCapability.handler(
		{ packageIds: ['package-1'], dryRun: false },
		createContext(['admin']),
	)
	expect(result.outcomes[0]).toMatchObject({
		outcome: 'resumed',
		rebuiltTargetCount: 3,
	})
	expect(mocks.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'owner-1',
			newCommit: 'commit-new',
			expectedHead: 'commit-new',
			allowForce: false,
			resumeFinalize: true,
		}),
	)
	expect(
		mocks.rebuildPublishedPackageArtifactsViaRepoSession,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			publishedCommit: 'commit-new',
		}),
	)
})

test('apply skips a package whose Artifacts HEAD differs from published_commit', async () => {
	mocks.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'commit-newer',
	})
	const result = await adminPublishFinalizeResumeCapability.handler(
		{ packageIds: ['package-1'], dryRun: false },
		createContext(['admin']),
	)
	expect(result.outcomes[0]).toMatchObject({ outcome: 'skipped_head_differs' })
	expect(mocks.publishFromExternalRef).not.toHaveBeenCalled()
})

test('dry-run reports complete only once sealed, jobs attributed, note attached, and artifacts built', async () => {
	mocks.publishedPublishChecksAreCurrent.mockResolvedValue(true)
	mocks.listJobsForUser.mockResolvedValue([
		{ source_id: 'source-1', record: { publishedCommit: 'commit-new' } },
	])
	mocks.readPublishGitNoteFromArtifactsRepo.mockResolvedValue({ found: true })
	mocks.countUnbuiltPublishedPackageArtifactTargets.mockResolvedValue({
		targetCount: 3,
		unbuiltCount: 1,
	})
	const incomplete = await adminPublishFinalizeResumeCapability.handler(
		{ packageIds: ['package-1'] },
		createContext(['admin']),
	)
	expect(incomplete.outcomes[0]).toMatchObject({
		outcome: 'incomplete',
		unbuiltArtifactTargetCount: 1,
	})
	mocks.countUnbuiltPublishedPackageArtifactTargets.mockResolvedValue({
		targetCount: 3,
		unbuiltCount: 0,
	})
	const result = await adminPublishFinalizeResumeCapability.handler(
		{ packageIds: ['package-1'] },
		createContext(['admin']),
	)
	expect(result.outcomes[0]).toMatchObject({
		outcome: 'complete',
		sealed: true,
		staleJobCount: 0,
		publishNoteFound: true,
	})
})
