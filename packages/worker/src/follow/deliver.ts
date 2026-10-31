import { parseListingOwnerUsername } from '#universal/community-links.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { deliverCommunityForkUpstreamUpdatedAlias } from '#worker/community/fork-upstream-updated-package-subscriptions.ts'
import { type CommunityListingRelease } from '#worker/community/fork-upstream-updated-subscription-event.ts'
import { getCommunityPackageHref } from '#worker/community/package-url.ts'
import {
	getActiveCommunityListingWithPublisherUsername,
	listCommunityForksByListingId,
} from '#worker/community/repo.ts'
import {
	loadMatchingPackageSubscriptions,
	type LoadedPackageSubscription,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { packageEventFiltersMatchPayload } from '#worker/package-invocations/subscription-dispatch.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import {
	loadFollowTargetSnapshot,
	resolveFollowDeliveryAccess,
} from './access.ts'
import {
	buildFollowPublishedEvent,
	buildFollowPushedEvent,
	followPublishedEventId,
	followPushedEventId,
} from './events.ts'
import {
	insertFollowRecentUpdate,
	markFollowDeliverySkip,
	pauseFollow,
} from './repo.ts'
import { type FollowRecentUpdateDetail } from '#universal/follows.ts'
import {
	followPublishedTopic,
	followPushedTopic,
	followZeroCreditsSkipReason,
	type FollowPushPending,
	type FollowRecord,
} from './types.ts'

const followSubscriptionActorTokenId = 'internal:follow-subscriptions'

export type FollowPublishedDelivery = {
	previousCommit: string | null
	publishedCommit: string
	publishedAt: string
}

export type FollowDeliveryHooks = {
	loadTarget?: typeof loadFollowTargetSnapshot
	resolveAccess?: typeof resolveFollowDeliveryAccess
	loadSubscriptions?: (input: {
		env: Env
		userId: string
		topic: string
		payload: Record<string, unknown>
	}) => Promise<
		| Array<LoadedPackageSubscription>
		| {
				subscriptions: Array<LoadedPackageSubscription>
				discoveryErrors: Array<unknown>
		  }
	>
	invoke?: typeof invokePackageSubscription
}

/**
 * Deliver `follow.published` or `follow.pushed` to active follows that chose
 * that event. Lost create-level access pauses the row. Push without `package:read`
 * (or org-wide `package:read` for a plain repo) is skipped and the follow
 * stays active. A 429 from invocation is recorded as `zero_credits` and
 * does not throw. An event no enabled package subscription handles is stored
 * as a Recent update for the follow (no credits), after the access recheck.
 */
export async function deliverFollowRecords(input: {
	env: Env
	follows: ReadonlyArray<FollowRecord>
	now: Date
	published?: FollowPublishedDelivery
	pushed?: FollowPushPending
	hooks?: FollowDeliveryHooks
}): Promise<void> {
	const mode = input.published ? 'published' : input.pushed ? 'pushed' : null
	if (!mode) return
	const nowIso = input.now.toISOString()
	for (const follow of input.follows) {
		if (follow.status !== 'active') continue
		try {
			await deliverOneFollow({
				env: input.env,
				follow,
				nowIso,
				published: input.published,
				pushed: input.pushed,
				hooks: input.hooks,
			})
		} catch (error) {
			console.error('follow-delivery-failed', {
				followId: follow.id,
				error,
			})
		}
	}
}

async function deliverOneFollow(input: {
	env: Env
	follow: FollowRecord
	nowIso: string
	published?: FollowPublishedDelivery
	pushed?: FollowPushPending
	hooks?: FollowDeliveryHooks
}) {
	const loadTarget = input.hooks?.loadTarget ?? loadFollowTargetSnapshot
	const resolveAccess =
		input.hooks?.resolveAccess ?? resolveFollowDeliveryAccess
	if (input.pushed && !input.follow.pushedEnabled) return
	if (input.published && !input.follow.publishedEnabled) return
	const target = await loadTarget(input.env.APP_DB, input.follow)
	if (!target) {
		await pauseFollow(input.env.APP_DB, {
			id: input.follow.id,
			pausedAt: input.nowIso,
			reason: 'target_missing',
		})
		return
	}
	const access = await resolveAccess({
		env: input.env,
		creatorUserId: input.follow.creatorUserId,
		creatorProfileId: input.follow.creatorProfileId,
		target,
	})
	if (!access.canCreate) {
		await pauseFollow(input.env.APP_DB, {
			id: input.follow.id,
			pausedAt: input.nowIso,
			reason: 'access_lost',
		})
		return
	}
	if (input.pushed) {
		if (!access.canPush) return
		const eventId = followPushedEventId()
		const payload = buildFollowPushedEvent({
			eventId,
			target,
			pending: input.pushed,
		})
		const pushed = input.pushed
		const result = await invokeFollowTopic({
			env: input.env,
			follow: input.follow,
			nowIso: input.nowIso,
			topic: followPushedTopic,
			payload,
			hooks: input.hooks,
			idempotencyKey: (packageId) =>
				`follow-pushed:${input.follow.id}:${pushed.windowStartedAt}:${pushed.afterCommit}:${packageId}`,
		})
		if (result === 'unhandled') {
			await recordRecentUpdate({
				env: input.env,
				follow: input.follow,
				nowIso: input.nowIso,
				dedupeKey: `pushed:${pushed.windowStartedAt}:${pushed.afterCommit}`,
				occurredAt: pushed.updatedAt,
				detail: {
					event: 'pushed',
					ref: pushed.ref,
					afterCommit: pushed.afterCommit,
					totalCommits: pushed.totalCommitsCount,
					latestMessage: pushed.commits.at(-1)?.message ?? null,
				},
			})
		}
		return
	}
	if (!input.published) return
	const eventId = followPublishedEventId()
	const payload = buildFollowPublishedEvent({
		eventId,
		targetName: target.name,
		previousCommit: input.published.previousCommit,
		publishedCommit: input.published.publishedCommit,
		publishedAt: input.published.publishedAt,
	})
	const published = input.published
	const result = await invokeFollowTopic({
		env: input.env,
		follow: input.follow,
		nowIso: input.nowIso,
		topic: followPublishedTopic,
		payload,
		hooks: input.hooks,
		idempotencyKey: (packageId) =>
			`follow-published:${input.follow.id}:${published.publishedCommit}:${packageId}`,
	})
	if (result === 'unhandled') {
		await recordRecentUpdate({
			env: input.env,
			follow: input.follow,
			nowIso: input.nowIso,
			dedupeKey: `published:${published.publishedCommit}`,
			occurredAt: published.publishedAt,
			detail: {
				event: 'published',
				publishedCommit: published.publishedCommit,
				previousCommit: published.previousCommit,
			},
		})
	}
}

async function recordRecentUpdate(input: {
	env: Env
	follow: FollowRecord
	nowIso: string
	dedupeKey: string
	occurredAt: string
	detail: FollowRecentUpdateDetail
}) {
	try {
		await insertFollowRecentUpdate(input.env.APP_DB, {
			id: crypto.randomUUID(),
			followerOrgId: input.follow.followerOrgId,
			followId: input.follow.id,
			dedupeKey: input.dedupeKey,
			detail: input.detail,
			occurredAt: input.occurredAt,
			createdAt: input.nowIso,
		})
	} catch (error) {
		console.error('follow-recent-update-failed', {
			followId: input.follow.id,
			error,
		})
	}
}

/** A declared subscription with no live enablement ran no handler. */
function subscriptionRanNoHandler(response: { status: number; body: unknown }) {
	if (response.status !== 202) return false
	const body = response.body as { skipped?: { reason?: unknown } } | null
	return body?.skipped?.reason === 'no_enablement_on'
}

/**
 * Compatibility alias for every fork still behind a moved listing pin.
 * Walks all forks of the listing, once each, including when the forker's
 * follow is paused or missing. Payload shape matches the historical fork
 * dispatcher. A 429 stays inside the alias helper and does not throw.
 */
export async function deliverListingForkAliases(input: {
	env: Env
	listingId: string
	previous: CommunityListingRelease
	current: CommunityListingRelease
	publishedAt: string
}): Promise<void> {
	if (input.previous.pinnedCommit === input.current.pinnedCommit) return
	try {
		const projection = await loadListingProjection(input.env, input.listingId)
		if (!projection) return
		const forks = await listCommunityForksByListingId(input.env.APP_DB, {
			listingId: input.listingId,
		})
		for (const fork of forks) {
			if (fork.originCommit === input.current.pinnedCommit) continue
			try {
				await deliverCommunityForkUpstreamUpdatedAlias({
					env: input.env,
					alias: {
						eventId: crypto.randomUUID(),
						listing: projection,
						fork,
						previous: input.previous,
						current: input.current,
						publishedAt: input.publishedAt,
					},
				})
			} catch (error) {
				console.error('follow-fork-alias-failed', {
					forkId: fork.id,
					error,
				})
			}
		}
	} catch (error) {
		console.error('follow-fork-alias-failed', input.listingId, error)
	}
}

async function loadListingProjection(env: Env, listingId: string) {
	const loaded = await getActiveCommunityListingWithPublisherUsername(
		env.APP_DB,
		{ listingId },
	)
	if (!loaded) return null
	const publisherUsername =
		loaded.publisherUsername ?? parseListingOwnerUsername(loaded.listing.name)
	const kodyId = loaded.listing.kodyId
	if (!publisherUsername || !kodyId) return null
	const description = loaded.listing.description.trim()
	return {
		id: loaded.listing.id,
		name: loaded.listing.name,
		kodyId,
		description: description.length > 0 ? description : null,
		publisherUsername,
		publishedAt: loaded.listing.publishedAt,
		publicUrl: `${getAppBaseUrl({ env })}${getCommunityPackageHref({
			username: publisherUsername,
			kodyId,
		})}`,
	}
}

async function invokeFollowTopic(input: {
	env: Env
	follow: FollowRecord
	nowIso: string
	topic: string
	payload: object
	hooks?: FollowDeliveryHooks
	idempotencyKey: (packageId: string) => string
}): Promise<
	'delivered' | 'zero_credits' | 'filtered' | 'unhandled' | 'failed'
> {
	const baseUrl = getAppBaseUrl({ env: input.env })
	const payload = input.payload as Record<string, unknown>
	const invoke = input.hooks?.invoke ?? invokePackageSubscription
	let subscriptions: Array<LoadedPackageSubscription> = []
	let filteredOut = false
	let discoveryIncomplete = false
	try {
		const loaded = input.hooks?.loadSubscriptions
			? await input.hooks.loadSubscriptions({
					env: input.env,
					userId: input.follow.followerOrgId,
					topic: input.topic,
					payload,
				})
			: await loadMatchingPackageSubscriptions({
					env: input.env,
					baseUrl,
					userId: input.follow.followerOrgId,
					topic: input.topic,
				})
		const declared = Array.isArray(loaded) ? loaded : loaded.subscriptions
		const discoveryErrors = Array.isArray(loaded) ? [] : loaded.discoveryErrors
		if (discoveryErrors.length > 0) {
			discoveryIncomplete = true
			console.error('follow-subscription-discovery-incomplete', {
				followId: input.follow.id,
				topic: input.topic,
				errors: discoveryErrors.length,
			})
		}
		subscriptions = declared.filter((entry) =>
			packageEventFiltersMatchPayload({
				filters: entry.subscription.filters,
				payload,
			}),
		)
		filteredOut = subscriptions.length < declared.length
	} catch (error) {
		console.error('follow-subscription-discovery-failed', {
			followId: input.follow.id,
			topic: input.topic,
			error,
		})
		return 'failed'
	}
	let delivered = false
	let zeroCredits = false
	let invokeFailed = false
	for (const { savedPackage } of subscriptions) {
		try {
			const response = await invoke({
				env: input.env,
				baseUrl,
				savedPackage,
				topic: input.topic,
				params: payload,
				idempotencyKey: input.idempotencyKey(savedPackage.id),
				source: 'follow',
				request: { kind: 'platform-event', sourceId: 'follow' },
				actorTokenId: followSubscriptionActorTokenId,
			})
			if (response.status === 429) {
				zeroCredits = true
				continue
			}
			if (subscriptionRanNoHandler(response)) continue
			delivered = true
		} catch (error) {
			invokeFailed = true
			console.error('follow-subscription-invoke-failed', {
				followId: input.follow.id,
				packageId: savedPackage.id,
				topic: input.topic,
				error,
			})
		}
	}
	if (zeroCredits) {
		await markFollowDeliverySkip(input.env.APP_DB, {
			id: input.follow.id,
			reason: followZeroCreditsSkipReason,
			skippedAt: input.nowIso,
		})
		return 'zero_credits'
	}
	if (delivered) return 'delivered'
	if (invokeFailed || discoveryIncomplete) return 'failed'
	return filteredOut ? 'filtered' : 'unhandled'
}
