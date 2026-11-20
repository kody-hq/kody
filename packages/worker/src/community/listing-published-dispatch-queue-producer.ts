export type CommunityListingPublishedDispatchQueueMessage = {
	eventId: string
	listingId: string
}

export async function enqueueCommunityListingPublishedDispatch(input: {
	queue: Pick<Queue<CommunityListingPublishedDispatchQueueMessage>, 'send'>
	listingId: string
}) {
	await input.queue.send({
		eventId: crypto.randomUUID(),
		listingId: input.listingId,
	})
}
