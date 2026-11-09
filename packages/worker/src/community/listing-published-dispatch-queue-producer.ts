import type { CommunityListingRelease } from './fork-upstream-updated-subscription-event.ts'

export type CommunityListingPublishedDispatchQueueMessage = {
	eventId: string
	listingId: string
}

export const communityForkUpstreamUpdatedDispatchKind = 'fork_upstream_updated'

/**
 * Legacy queue shape. Origin no longer enqueues it. The consumer acks any
 * in-flight copy without fan-out; the follow pipeline emits the alias.
 */
export type CommunityForkUpstreamUpdatedDispatchQueueMessage = {
	kind: typeof communityForkUpstreamUpdatedDispatchKind
	eventId: string
	listingId: string
	previous: CommunityListingRelease
	current: CommunityListingRelease
	publishedAt: string
}

type CommunityListingDispatchQueueMessage =
	| CommunityListingPublishedDispatchQueueMessage
	| CommunityForkUpstreamUpdatedDispatchQueueMessage

export async function enqueueCommunityListingPublishedDispatch(input: {
	queue: Pick<Queue<CommunityListingDispatchQueueMessage>, 'send'>
	listingId: string
}) {
	await input.queue.send({
		eventId: crypto.randomUUID(),
		listingId: input.listingId,
	})
}
