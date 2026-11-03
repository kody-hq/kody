import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import type { CommunityListingRelease } from './fork-upstream-updated-subscription-event.ts'
import {
	communityForkUpstreamUpdatedDispatchKind,
	type CommunityForkUpstreamUpdatedDispatchQueueMessage,
	type CommunityListingPublishedDispatchQueueMessage,
} from './listing-published-dispatch-queue-producer.ts'
import { dispatchCommunityListingPublishedSubscriptionEvent } from './listing-published-package-subscriptions.ts'

const communityListingPublishedDispatchRetryDelaySeconds = 30

type ParsedCommunityListingDispatchQueueMessage =
	| ({ kind: 'published' } & CommunityListingPublishedDispatchQueueMessage)
	| CommunityForkUpstreamUpdatedDispatchQueueMessage

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

function parseCommunityListingRelease(
	value: unknown,
): CommunityListingRelease | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	const pinnedCommit = readNonEmptyString(record['pinnedCommit'])
	const packageVersion = record['packageVersion']
	if (
		!pinnedCommit ||
		(packageVersion !== null && typeof packageVersion !== 'string')
	) {
		return null
	}
	return { pinnedCommit, packageVersion }
}

function parseCommunityListingPublishedDispatchQueueMessage(
	body: unknown,
): ParsedCommunityListingDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const eventId = readNonEmptyString(record['eventId'])
	const listingId = readNonEmptyString(record['listingId'])
	if (!eventId || !listingId) return null
	if (record['kind'] === communityForkUpstreamUpdatedDispatchKind) {
		const previous = parseCommunityListingRelease(record['previous'])
		const current = parseCommunityListingRelease(record['current'])
		const publishedAt = readNonEmptyString(record['publishedAt'])
		if (!previous || !current || !publishedAt) return null
		return {
			kind: communityForkUpstreamUpdatedDispatchKind,
			eventId,
			listingId,
			previous,
			current,
			publishedAt,
		}
	}
	if (Object.keys(record).length !== 2) return null
	return { kind: 'published', eventId, listingId }
}

async function dispatchParsedMessage(
	env: Env,
	parsed: ParsedCommunityListingDispatchQueueMessage,
) {
	switch (parsed.kind) {
		case 'published':
			await dispatchCommunityListingPublishedSubscriptionEvent({
				env,
				eventId: parsed.eventId,
				listingId: parsed.listingId,
			})
			return
		case communityForkUpstreamUpdatedDispatchKind:
			// In-flight messages from the retired fork-only dispatcher are
			// acknowledged without fan-out. New pin moves emit
			// community.fork.upstream_updated from the follow pipeline.
			return
		default: {
			const exhaustive: never = parsed
			return exhaustive
		}
	}
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
