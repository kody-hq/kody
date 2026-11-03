import { dispatchCommunityActivityRecordedSubscriptionEvent } from './activity-package-subscriptions.ts'
import type { CommunityActivityDispatchQueueMessage } from './activity-dispatch-queue-producer.ts'
import { CommunityActivityDispatchCancelledError } from './errors.ts'
import { communityActivityKinds } from './types.ts'

const communityActivityDispatchRetryDelaySeconds = 30

function parseCommunityActivityDispatchQueueMessage(
	body: unknown,
): CommunityActivityDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const eventId = record['eventId']
	const kind = record['kind']
	const activityId = record['activityId']
	if (
		Object.keys(record).length !== 3 ||
		typeof eventId !== 'string' ||
		!eventId.trim() ||
		typeof kind !== 'string' ||
		!communityActivityKinds.some((candidate) => candidate === kind) ||
		typeof activityId !== 'string' ||
		!activityId.trim()
	) {
		return null
	}
	return {
		eventId: eventId.trim(),
		kind: kind as CommunityActivityDispatchQueueMessage['kind'],
		activityId: activityId.trim(),
	}
}

export async function handleCommunityActivityDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
) {
	for (const queueMessage of batch.messages) {
		const parsed = parseCommunityActivityDispatchQueueMessage(queueMessage.body)
		if (!parsed) {
			queueMessage.ack()
			continue
		}
		try {
			await dispatchCommunityActivityRecordedSubscriptionEvent({
				env,
				...parsed,
			})
			queueMessage.ack()
		} catch (error) {
			if (error instanceof CommunityActivityDispatchCancelledError) {
				queueMessage.ack()
				continue
			}
			console.error('community-activity-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				...parsed,
				error,
			})
			queueMessage.retry({
				delaySeconds: communityActivityDispatchRetryDelaySeconds,
			})
		}
	}
}
