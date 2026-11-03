import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	loadMatchingPackageSubscriptions,
	type LoadedPackageSubscription,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { packageEventFiltersMatchPayload } from '#worker/package-invocations/subscription-dispatch.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import {
	buildCommunityForkUpstreamUpdatedEvent,
	communityForkUpstreamUpdatedTopic,
	type CommunityListingRelease,
} from './fork-upstream-updated-subscription-event.ts'
import type { CommunityListingPublishedProjection } from './listing-published-subscription-event.ts'
import type { CommunityForkRecord } from './types.ts'

const communityForkUpstreamUpdatedSubscriptionActorTokenId =
	'internal:community-fork-upstream-updated-subscriptions'

type CommunityForkUpstreamUpdatedAliasInput = {
	eventId: string
	listing: CommunityListingPublishedProjection
	fork: CommunityForkRecord
	previous: CommunityListingRelease
	current: CommunityListingRelease
	publishedAt: string
}

/** Same object `buildCommunityForkUpstreamUpdatedEvent` returns. */
function communityForkUpstreamUpdatedAliasParams(
	input: CommunityForkUpstreamUpdatedAliasInput,
) {
	return buildCommunityForkUpstreamUpdatedEvent(input)
}

type FollowAliasInvokeResult = 'delivered' | 'zero_credits' | 'none' | 'failed'

/**
 * Compatibility alias for one fork. Emitted from the follow pipeline when a
 * `follow.published` delivery corresponds to a community listing pin move.
 * Payload shape matches the historical fork dispatcher. A 429 (credits or
 * run limit, before the handler runs) does not throw, so nothing is queued
 * for retry.
 */
export async function deliverCommunityForkUpstreamUpdatedAlias(input: {
	env: Env
	baseUrl?: string
	alias: CommunityForkUpstreamUpdatedAliasInput
}): Promise<FollowAliasInvokeResult> {
	const baseUrl = input.baseUrl ?? getAppBaseUrl({ env: input.env })
	const params = communityForkUpstreamUpdatedAliasParams(input.alias)
	let subscriptions: Array<LoadedPackageSubscription> = []
	try {
		const loaded = await loadMatchingPackageSubscriptions({
			env: input.env,
			baseUrl,
			userId: input.alias.fork.forkerUserId,
			topic: communityForkUpstreamUpdatedTopic,
		})
		if (loaded.discoveryErrors.length > 0) {
			console.error('community-fork-upstream-updated-discovery-failed', {
				forkId: input.alias.fork.id,
				error: loaded.discoveryErrors[0],
			})
		}
		subscriptions = loaded.subscriptions.filter((entry) =>
			packageEventFiltersMatchPayload({
				filters: entry.subscription.filters,
				payload: params as unknown as Record<string, unknown>,
			}),
		)
	} catch (error) {
		console.error('community-fork-upstream-updated-discovery-failed', {
			forkId: input.alias.fork.id,
			error,
		})
		return 'failed'
	}
	if (subscriptions.length === 0) return 'none'
	let delivered = false
	let zeroCredits = false
	let failed = false
	for (const { savedPackage } of subscriptions) {
		try {
			const response = await invokePackageSubscription({
				env: input.env,
				baseUrl,
				savedPackage,
				topic: communityForkUpstreamUpdatedTopic,
				params: params as unknown as Record<string, unknown>,
				idempotencyKey: `community-fork-upstream-updated:${input.alias.listing.id}:${input.alias.current.pinnedCommit}:${input.alias.fork.id}:${savedPackage.id}`,
				source: 'community-fork-upstream-updated',
				request: {
					kind: 'platform-event',
					sourceId: 'community-fork-upstream-updated',
				},
				actorTokenId: communityForkUpstreamUpdatedSubscriptionActorTokenId,
				audience: {
					resource: { type: 'package', id: input.alias.fork.forkedPackageId },
				},
			})
			if (response.status === 429) {
				zeroCredits = true
				continue
			}
			delivered = true
		} catch (error) {
			failed = true
			console.error('community-fork-upstream-updated-invocation-failed', {
				forkId: input.alias.fork.id,
				packageId: savedPackage.id,
				error,
			})
		}
	}
	if (zeroCredits) return 'zero_credits'
	if (failed && !delivered) return 'failed'
	return delivered ? 'delivered' : 'none'
}
