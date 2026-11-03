import type { CommunityActivityKind } from './types.ts'

export type CommunityActivityDispatchQueueMessage = {
	eventId: string
	kind: CommunityActivityKind
	activityId: string
}

export async function enqueueCommunityActivityDispatch(input: {
	queue: Pick<Queue<CommunityActivityDispatchQueueMessage>, 'send'>
	kind: CommunityActivityKind
	activityId: string
}) {
	await input.queue.send({
		eventId: crypto.randomUUID(),
		kind: input.kind,
		activityId: input.activityId,
	})
}
