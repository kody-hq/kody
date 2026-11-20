import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import type { CommunityListingPublishedDispatchQueueMessage } from './listing-published-dispatch-queue-producer.ts'
import { dispatchCommunityListingPublishedSubscriptionEvent } from './listing-published-package-subscriptions.ts'

const communityListingPublishedDispatchRetryDelaySeconds = 30

type ParsedCommunityListingDispatchQueueMessage = {
	kind: 'published'
} & CommunityListingPublishedDispatchQueueMessage

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

function parseCommunityListingPublishedDispatchQueueMessage(
	body: unknown,
): ParsedCommunityListingDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const eventId = readNonEmptyString(record['eventId'])
	const listingId = readNonEmptyString(record['listingId'])
	if (!eventId || !listingId) return null
	if (Object.keys(record).length !== 2) return null
	return { kind: 'published', eventId, listingId }
}

async function dispatchParsedMessage(
	env: Env,
	parsed: ParsedCommunityListingDispatchQueueMessage,
) {
	await dispatchCommunityListingPublishedSubscriptionEvent({
		env,
		eventId: parsed.eventId,
		listingId: parsed.listingId,
	})
}

export async function handleCommunityListingPublishedDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
) {
	for (const queueMessage of batch.messages) {
		const parsed = parseCommunityListingPublishedDispatchQueueMessage(
			queueMessage.body,
		)
		if (!parsed) {
			queueMessage.ack()
			continue
		}
		try {
			await dispatchParsedMessage(env, parsed)
			queueMessage.ack()
		} catch (error) {
			if (error instanceof CommunityListingPublishedDispatchCancelledError) {
				queueMessage.ack()
				continue
			}
			console.error(
				'community-listing-published-dispatch-queue-processing-failed',
				{
					queueMessageId: queueMessage.id,
					kind: parsed.kind,
					eventId: parsed.eventId,
					listingId: parsed.listingId,
					error,
				},
			)
			queueMessage.retry({
				delaySeconds: communityListingPublishedDispatchRetryDelaySeconds,
			})
		}
	}
}
