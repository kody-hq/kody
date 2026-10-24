import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import type * as Artifacts from './artifacts.ts'
import type * as IdentityIcon from './identity-icon.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	getEntitySourceByRepoId: vi.fn(),
	getUserRepoById: vi.fn(),
	getSavedPackageById: vi.fn(),
	ensureArtifactsRepoPushSubscription: vi.fn(async () => ({
		subscriptionId: 'sub-1',
		skipped: false,
	})),
	getArtifactsNamespace: vi.fn(() => 'production'),
	resolveArtifactSourceHead: vi.fn<typeof Artifacts.resolveArtifactSourceHead>(
		async () => ({
			branch: 'main',
			commit: 'def789ghi012def789ghi012def789ghi012def7',
		}),
	),
	applyArtifactSourcePushToHeadCache: vi.fn(async () => {}),
	isDeletedArtifactRefCommit: (commit: string) => /^0+$/.test(commit),
	readCachedArtifactSourceBranch: vi.fn(async () => null as string | null),
	refreshIdentityIconForSource: vi.fn<
		typeof IdentityIcon.refreshIdentityIconForSource
	>(async () => {}),
	recordFollowDefaultBranchPush: vi.fn(async () => undefined),
}))

vi.mock('#worker/package-invocations/service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#worker/package-invocations/service.ts')
		>()
	return {
		...actual,
		invokePackageSubscription: mocks.invokePackageSubscription,
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	getSavedPackageById: mocks.getSavedPackageById,
}))

vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

vi.mock('./entity-sources.ts', () => ({
	getEntitySourceByRepoId: mocks.getEntitySourceByRepoId,
}))

vi.mock('./user-repos.ts', () => ({
	getUserRepoById: mocks.getUserRepoById,
}))

vi.mock('./artifacts-push-subscriptions.ts', () => ({
	ensureArtifactsRepoPushSubscription:
		mocks.ensureArtifactsRepoPushSubscription,
}))

vi.mock('./artifacts.ts', () => ({
	getArtifactsNamespace: mocks.getArtifactsNamespace,
	resolveArtifactSourceHead: mocks.resolveArtifactSourceHead,
}))

vi.mock('./artifact-head-cache.ts', () => ({
	applyArtifactSourcePushToHeadCache: mocks.applyArtifactSourcePushToHeadCache,
	isDeletedArtifactRefCommit: mocks.isDeletedArtifactRefCommit,
	readCachedArtifactSourceBranch: mocks.readCachedArtifactSourceBranch,
}))

vi.mock('./identity-icon.ts', () => ({
	refreshIdentityIconForSource: mocks.refreshIdentityIconForSource,
}))

vi.mock('#worker/follow/push-ingress.ts', () => ({
	recordFollowDefaultBranchPush: mocks.recordFollowDefaultBranchPush,
}))

const { dispatchRepoSubscriptionEvents, processCloudflareArtifactsRepoEvent } =
	await import('./package-subscriptions.ts')

const source = {
	id: 'source-1',
	user_id: ownerIdFromStored('user-1'),
	entity_kind: 'repo' as const,
	entity_id: 'user-repo-1',
	repo_id: 'repo-user-repo-1',
	published_commit: null,
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-05-18T00:00:00.000Z',
	updated_at: '2026-05-18T00:00:00.000Z',
}

const pushedEvent = {
	type: 'cf.artifacts.repo.pushed' as const,
	source: {
		type: 'artifacts.repo' as const,
		namespace: 'production',
		repoName: 'repo-user-repo-1',
	},
	payload: {
		ref: 'refs/heads/main',
		before: 'abc123def456abc123def456abc123def456abc1',
		after: 'def789ghi012def789ghi012def789ghi012def7',
		commits: [
			{
				id: 'def789ghi012def789ghi012def789ghi012def7',
				message: 'Sync skills',
				messageTruncated: false,
				timestamp: '2026-05-01T02:48:57.000Z',
				author: { name: 'Dev', email: 'dev@example.com' },
				committer: { name: 'Dev', email: 'dev@example.com' },
				parents: ['abc123def456abc123def456abc123def456abc1'],
			},
		],
		totalCommitsCount: 1,
		commitsTruncated: false,
	},
	metadata: {
		accountId: 'account-1',
		eventSubscriptionId: 'subscription-1',
		eventSchemaVersion: 1,
		eventTimestamp: '2026-05-01T02:48:57.132Z',
	},
}

const userRepo = {
	id: 'user-repo-1',
	userId: ownerIdFromStored('user-1'),
	name: 'skills',
	description: null,
	createdAt: '2026-05-18T00:00:00.000Z',
	updatedAt: '2026-05-18T00:00:00.000Z',
}

const env = {
	APP_DB: {},
	BUNDLE_ARTIFACTS_KV: {},
	APP_BASE_URL: 'https://example.com',
	ARTIFACTS_NAMESPACE: 'production',
} as Env

function pushEvent(payload: Partial<typeof pushedEvent.payload> = {}) {
	return { ...pushedEvent, payload: { ...pushedEvent.payload, ...payload } }
}

function seedMatchedSource() {
	mocks.getEntitySourceByRepoId.mockResolvedValueOnce(source)
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([])
	mocks.getUserRepoById.mockResolvedValueOnce(userRepo)
}

test('repo.pushed fans out only to the owning user packages', async () => {
	const savedPackage = {
		id: 'package-1',
		userId: ownerIdFromStored('user-1'),
		sourceId: 'source-pkg-1',
		kodyId: 'skills-resync',
		name: '@user/skills-resync',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/skills-resync',
			kody: {
				id: 'skills-resync',
				description: 'Resync on push',
				subscriptions: {
					'repo.pushed': { handler: './src/on-repo-pushed.ts' },
				},
			},
		},
	})
	mocks.getUserRepoById.mockResolvedValueOnce(userRepo)

	await dispatchRepoSubscriptionEvents({
		env,
		providerEvent: pushedEvent,
		source,
	})

	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: 'repo.pushed',
			source: 'repo',
			idempotencyKey:
				'repo-push:repo-user-repo-1:def789ghi012def789ghi012def789ghi012def7:refs/heads/main:package-1',
			params: expect.objectContaining({
				event: 'repo.pushed',
				repo: expect.objectContaining({
					source_id: 'source-1',
					repo_id: 'repo-user-repo-1',
					entity_kind: 'repo',
					name: 'skills',
					kody_id: null,
				}),
				push: expect.objectContaining({
					ref: 'refs/heads/main',
					after: 'def789ghi012def789ghi012def789ghi012def7',
				}),
			}),
		}),
	)
})

test('processCloudflareArtifactsRepoEvent ignores, unmatched, and dispatches by entity_sources lookup', async () => {
	const ignoredBodies = [
		{
			...pushedEvent,
			source: { ...pushedEvent.source, namespace: 'preview' },
		},
		{
			...pushedEvent,
			source: { ...pushedEvent.source, repoName: 'package-abc-session-def' },
		},
		pushEvent({
			ref: 'refs/heads/sessions/f3da2ca724024325b290a21318c6b353-14bcbfbb49c94cf782dc0ebc5971a4cd',
		}),
		pushEvent({ ref: 'refs/heads/kody-published' }),
		pushEvent({ ref: 'refs/notes/commits' }),
	]
	for (const body of ignoredBodies) {
		const result = await processCloudflareArtifactsRepoEvent({ env, body })
		expect([body.source, body.payload.ref, result.outcome]).toEqual([
			body.source,
			body.payload.ref,
			'ignored',
		])
	}
	// Ignored events never touch the cached HEAD.
	expect(mocks.applyArtifactSourcePushToHeadCache).not.toHaveBeenCalled()

	mocks.getEntitySourceByRepoId.mockResolvedValueOnce(null)
	const unmatched = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(unmatched.outcome).toBe('unmatched')
	expect(mocks.applyArtifactSourcePushToHeadCache).toHaveBeenCalledWith({
		env,
		repoId: 'repo-user-repo-1',
		ref: 'refs/heads/main',
		after: 'def789ghi012def789ghi012def789ghi012def7',
	})

	seedMatchedSource()
	const dispatched = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(dispatched.outcome).toBe('dispatched')
	expect(mocks.getEntitySourceByRepoId).toHaveBeenCalledWith(
		env.APP_DB,
		'repo-user-repo-1',
	)
	expect(mocks.refreshIdentityIconForSource).toHaveBeenCalledWith(
		expect.objectContaining({
			source,
			iconCommit: 'def789ghi012def789ghi012def789ghi012def7',
			indexLiveHead: true,
		}),
	)
})

test('repo.pushed refreshes identity icons only for the current default-branch HEAD', async () => {
	const after = pushedEvent.payload.after
	const featureAfter = 'aaa111bbb222aaa111bbb222aaa111bbb222aaa1'
	const deletedAfter = '0000000000000000000000000000000000000000'
	const cases: Array<{
		name: string
		ref?: string
		after?: string
		head: { branch: string; commit: string | null }
		iconCommit: string | null
	}> = [
		{
			name: 'matching',
			head: { branch: 'main', commit: after },
			iconCommit: after,
		},
		{
			name: 'default branch named develop',
			ref: 'refs/heads/develop',
			after: featureAfter,
			head: { branch: 'develop', commit: featureAfter },
			iconCommit: featureAfter,
		},
		{
			name: 'unresolved head',
			head: { branch: 'main', commit: null },
			iconCommit: null,
		},
		{
			name: 'non-default branch',
			ref: 'refs/heads/feature',
			after: featureAfter,
			head: { branch: 'main', commit: after },
			iconCommit: null,
		},
		{
			name: 'deleted ref',
			after: deletedAfter,
			head: { branch: 'main', commit: after },
			iconCommit: null,
		},
		{
			name: 'stale push',
			after: featureAfter,
			head: { branch: 'main', commit: after },
			iconCommit: null,
		},
	]
	for (const { name, ref, after: pushAfter, head, iconCommit } of cases) {
		mocks.refreshIdentityIconForSource.mockClear()
		mocks.resolveArtifactSourceHead.mockResolvedValueOnce(head)
		seedMatchedSource()
		const result = await processCloudflareArtifactsRepoEvent({
			env,
			body: pushEvent({
				ref: ref ?? pushedEvent.payload.ref,
				after: pushAfter ?? after,
			}),
		})
		const refreshed = mocks.refreshIdentityIconForSource.mock.calls.map(
			([input]) => [input.source, input.iconCommit, input.indexLiveHead],
		)
		expect([name, result.outcome, refreshed]).toEqual([
			name,
			'dispatched',
			iconCommit ? [[source, iconCommit, true]] : [],
		])
	}

	mocks.refreshIdentityIconForSource.mockClear()
	mocks.recordFollowDefaultBranchPush.mockClear()
	consoleError.mockImplementation(() => {})
	mocks.resolveArtifactSourceHead.mockRejectedValueOnce(
		new Error(
			'Artifacts repo "repo-user-repo-1" is importing. Retry after 5s.',
		),
	)
	seedMatchedSource()
	const lookupFailed = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(lookupFailed.outcome).toBe('dispatched')
	expect(mocks.refreshIdentityIconForSource).not.toHaveBeenCalled()
	expect(mocks.recordFollowDefaultBranchPush).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'identity-icon-push-refresh-failed',
		'repo-user-repo-1',
		expect.objectContaining({
			message:
				'Artifacts repo "repo-user-repo-1" is importing. Retry after 5s.',
		}),
	)
})

test('a default-branch tip is recorded for follows when icon refresh throws', async () => {
	consoleError.mockImplementation(() => {})
	mocks.recordFollowDefaultBranchPush.mockClear()
	mocks.refreshIdentityIconForSource.mockRejectedValueOnce(
		new Error('icon bytes missing'),
	)
	seedMatchedSource()
	const result = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(result.outcome).toBe('dispatched')
	expect(mocks.recordFollowDefaultBranchPush).toHaveBeenCalledTimes(1)
	expect(mocks.recordFollowDefaultBranchPush).toHaveBeenCalledWith({
		env,
		source,
		event: pushedEvent,
	})
	expect(consoleError).toHaveBeenCalledWith(
		'identity-icon-push-refresh-failed',
		'repo-user-repo-1',
		expect.objectContaining({ message: 'icon bytes missing' }),
	)
})

test('a default-branch push that is not the live tip is still recorded', async () => {
	mocks.recordFollowDefaultBranchPush.mockClear()
	mocks.refreshIdentityIconForSource.mockClear()
	mocks.resolveArtifactSourceHead.mockResolvedValueOnce({
		branch: 'main',
		commit: 'live-head-commit-not-this-push-000000000000',
	})
	seedMatchedSource()
	const result = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(result.outcome).toBe('dispatched')
	expect(mocks.refreshIdentityIconForSource).not.toHaveBeenCalled()
	expect(mocks.recordFollowDefaultBranchPush).toHaveBeenCalledTimes(1)
	expect(mocks.recordFollowDefaultBranchPush).toHaveBeenCalledWith({
		env,
		source,
		event: pushedEvent,
	})
})

test('a non-default or deleted push is not recorded for follows', async () => {
	mocks.recordFollowDefaultBranchPush.mockClear()
	mocks.refreshIdentityIconForSource.mockClear()
	seedMatchedSource()
	const feature = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushEvent({
			ref: 'refs/heads/feature',
			after: 'aaa111bbb222aaa111bbb222aaa111bbb222aaa1',
		}),
	})
	expect(feature.outcome).toBe('dispatched')
	seedMatchedSource()
	const deleted = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushEvent({ after: '0000000000000000000000000000000000000000' }),
	})
	expect(deleted.outcome).toBe('dispatched')
	expect(mocks.recordFollowDefaultBranchPush).not.toHaveBeenCalled()
	expect(mocks.refreshIdentityIconForSource).not.toHaveBeenCalled()
})

test('a default-branch push is recorded from the cached branch when head lookup throws', async () => {
	consoleError.mockImplementation(() => {})
	mocks.recordFollowDefaultBranchPush.mockClear()
	mocks.refreshIdentityIconForSource.mockClear()
	mocks.resolveArtifactSourceHead.mockRejectedValueOnce(
		new Error('Artifacts repo is importing'),
	)
	mocks.readCachedArtifactSourceBranch.mockResolvedValueOnce('main')
	seedMatchedSource()
	const result = await processCloudflareArtifactsRepoEvent({
		env,
		body: pushedEvent,
	})
	expect(result.outcome).toBe('dispatched')
	expect(mocks.refreshIdentityIconForSource).not.toHaveBeenCalled()
	expect(mocks.recordFollowDefaultBranchPush).toHaveBeenCalledTimes(1)
	expect(consoleError).toHaveBeenCalledWith(
		'identity-icon-push-refresh-failed',
		'repo-user-repo-1',
		expect.objectContaining({ message: 'Artifacts repo is importing' }),
	)
})
