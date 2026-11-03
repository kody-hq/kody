import type { CommunityListingPublishedProjection } from './listing-published-subscription-event.ts'
import type { CommunityForkRecord } from './types.ts'

export const communityForkUpstreamUpdatedTopic =
	'community.fork.upstream_updated'

export type CommunityListingRelease = {
	pinnedCommit: string
	packageVersion: string | null
}

type CommunityListingReleasePayload = {
	pinned_commit: string
	package_version: string | null
}

export type CommunityForkUpstreamUpdatedEvent = {
	event: typeof communityForkUpstreamUpdatedTopic
	event_id: string
	listing: {
		id: string
		name: string
		kody_id: string
		public_url: string
	}
	publisher: {
		username: string | null
	}
	fork: {
		id: string
		package_id: string
		kody_id: string
		origin_commit: string
		forked_at: string
	}
	previous: CommunityListingReleasePayload
	current: CommunityListingReleasePayload
	published_at: string
}

/**
 * A republish is an upstream update for forks only when the pinned commit
 * moved. `package.json#version` is read from that commit, so a version bump
 * always moves it too; comparing versions directly would only misfire on
 * listings whose stored version predates the column.
 */
export function hasCommunityListingReleaseChanged(input: {
	previous: CommunityListingRelease
	current: CommunityListingRelease
}): boolean {
	return input.previous.pinnedCommit !== input.current.pinnedCommit
}

function toReleasePayload(
	release: CommunityListingRelease,
): CommunityListingReleasePayload {
	return {
		pinned_commit: release.pinnedCommit,
		package_version: release.packageVersion,
	}
}

export function buildCommunityForkUpstreamUpdatedEvent(input: {
	eventId: string
	listing: CommunityListingPublishedProjection
	fork: CommunityForkRecord
	previous: CommunityListingRelease
	current: CommunityListingRelease
	publishedAt: string
}): CommunityForkUpstreamUpdatedEvent {
	return {
		event: communityForkUpstreamUpdatedTopic,
		event_id: input.eventId,
		listing: {
			id: input.listing.id,
			name: input.listing.name,
			kody_id: input.listing.kodyId,
			public_url: input.listing.publicUrl,
		},
		publisher: {
			username: input.listing.publisherUsername,
		},
		fork: {
			id: input.fork.id,
			package_id: input.fork.forkedPackageId,
			kody_id: input.fork.targetKodyId,
			origin_commit: input.fork.originCommit,
			forked_at: input.fork.createdAt,
		},
		previous: toReleasePayload(input.previous),
		current: toReleasePayload(input.current),
		published_at: input.publishedAt,
	}
}
