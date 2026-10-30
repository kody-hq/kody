import { beforeEach, expect, test, vi } from 'vitest'
import { createSubscriptionDiscoverySourceMocks } from '#worker/test-support/package-subscription-source-mocks.ts'
import { type CommunityForkRecord } from './types.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
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
}))
vi.mock('#worker/package-registry/source.ts', () =>
	createSubscriptionDiscoverySourceMocks(mocks.loadPackageManifestBySourceId),
)

const { deliverCommunityForkUpstreamUpdatedAlias } =
	await import('./fork-upstream-updated-package-subscriptions.ts')

const listing = {
	id: 'listing-1',
	name: '@owner/discord-gateway',
	kodyId: 'discord-gateway',
	description: 'Discord helpers',
	publisherUsername: 'owner',
	publishedAt: '2026-09-30T12:00:00.000Z',
	publicUrl: 'https://heykody.dev/@owner/discord-gateway',
}

const fork: CommunityForkRecord = {
	id: 'fork-1',
	listingId: 'listing-1',
	forkerUserId: 'stable-forker-a',
	originCommit: 'commit-1',
	forkedPackageId: 'forked-package-1',
	forkedSourceId: 'forked-source-1',
	targetKodyId: 'discord-gateway',
	createdAt: '2026-09-01T00:00:00.000Z',
	adoptedAt: null,
	adoptionNote: null,
}

const alias = {
	eventId: 'event-1',
	listing,
	fork,
	previous: { pinnedCommit: 'commit-1', packageVersion: '1.0.0' },
	current: { pinnedCommit: 'commit-2', packageVersion: '1.1.0' },
	publishedAt: '2026-09-30T12:00:00.000Z',
}

beforeEach(() => {
	mocks.invokePackageSubscription.mockReset()
	mocks.invokePackageSubscription.mockResolvedValue({ status: 200, body: {} })
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		{
			id: 'auto-rebase',
			userId: 'stable-forker-a',
			sourceId: 'source-auto-rebase',
			kodyId: 'auto-rebase',
			name: '@forker/auto-rebase',
		},
	])
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			kody: {
				subscriptions: {
					'community.fork.upstream_updated': {
						handler: './src/on-upstream.ts',
					},
				},
			},
		},
	})
})

test('follow alias emits the historical community.fork.upstream_updated payload', async () => {
	const result = await deliverCommunityForkUpstreamUpdatedAlias({
		env: {
			APP_DB: {} as D1Database,
			BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			APP_BASE_URL: 'https://heykody.dev',
		} as Env,
		alias,
	})
	expect(result).toBe('delivered')
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	const call = mocks.invokePackageSubscription.mock.calls[0]?.[0] as {
		topic: string
		params: Record<string, unknown>
		idempotencyKey: string
	}
	expect(call.topic).toBe('community.fork.upstream_updated')
	expect(call.idempotencyKey).toBe(
		'community-fork-upstream-updated:listing-1:commit-2:fork-1:auto-rebase',
	)
	expect(call.params).toEqual({
		event: 'community.fork.upstream_updated',
		event_id: 'event-1',
		listing: {
			id: 'listing-1',
			name: '@owner/discord-gateway',
			kody_id: 'discord-gateway',
			public_url: 'https://heykody.dev/@owner/discord-gateway',
		},
		publisher: { username: 'owner' },
		fork: {
			id: 'fork-1',
			package_id: 'forked-package-1',
			kody_id: 'discord-gateway',
			origin_commit: 'commit-1',
			forked_at: '2026-09-01T00:00:00.000Z',
		},
		previous: { pinned_commit: 'commit-1', package_version: '1.0.0' },
		current: { pinned_commit: 'commit-2', package_version: '1.1.0' },
		published_at: '2026-09-30T12:00:00.000Z',
	})
})

test('a 429 credit denial is recorded as zero_credits and does not throw', async () => {
	mocks.invokePackageSubscription.mockResolvedValue({
		status: 429,
		body: { error: { code: 'entitlement_limit_exceeded' } },
	})
	await expect(
		deliverCommunityForkUpstreamUpdatedAlias({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
				APP_BASE_URL: 'https://heykody.dev',
			} as Env,
			alias,
		}),
	).resolves.toBe('zero_credits')
})
