import {
	scheduledDispatchDeadLetterQueueName,
	scheduledDispatchQueueName,
} from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import {
	communityActivityDispatchDeadLetterQueueName,
	communityActivityDispatchQueueName,
} from '#worker/community/activity-dispatch-queue-names.ts'
import {
	communityListingPublishedDispatchDeadLetterQueueName,
	communityListingPublishedDispatchQueueName,
} from '#worker/community/listing-published-dispatch-queue-names.ts'
import {
	emailDeliveryDeadLetterQueueName,
	emailDeliveryQueueName,
} from '#worker/email/delivery-queue-names.ts'
import {
	packageEventsDispatchDeadLetterQueueName,
	packageEventsDispatchQueueName,
} from '#worker/package-events/dispatch-queue-names.ts'
import {
	platformFeedbackDispatchDeadLetterQueueName,
	platformFeedbackDispatchQueueName,
} from '#worker/platform-feedback/dispatch-queue-names.ts'
import {
	artifactsRepoEventsDeadLetterQueueName,
	artifactsRepoEventsQueueName,
} from '#worker/repo/artifacts-event-queue-names.ts'
import {
	webhookDispatchDeadLetterQueueName,
	webhookDispatchQueueName,
} from '#worker/webhooks/dispatch-queue-names.ts'

export type DeadLetterProducerBinding =
	| 'PLATFORM_FEEDBACK_DISPATCH_QUEUE'
	| 'COMMUNITY_ACTIVITY_DISPATCH_QUEUE'
	| 'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE'
	| 'PACKAGE_EVENTS_DISPATCH_QUEUE'
	| 'WEBHOOK_DISPATCH_QUEUE'

/**
 * How a parked message goes back to its source queue: through the main
 * worker's producer binding, through the jobs worker (which owns the
 * scheduled-dispatch producer), or not at all when the origin worker has no
 * producer binding for the source queue.
 */
export type DeadLetterReplayTarget =
	| { kind: 'producer'; binding: DeadLetterProducerBinding }
	| { kind: 'scheduled-dispatch' }
	| { kind: 'unsupported'; reason: string }

export type DeadLetterQueueDefinition = {
	name: string
	sourceQueue: string
	replay: DeadLetterReplayTarget
}

/**
 * Every production dead-letter queue in packages/worker/wrangler.jsonc and
 * packages/jobs-worker/wrangler.jsonc. The main worker consumes all of them
 * (see dead-letter/consumer.ts); production-queue-resources.node.test.ts
 * keeps this list and the wrangler config in sync.
 */
export const deadLetterQueues = [
	{
		name: emailDeliveryDeadLetterQueueName,
		sourceQueue: emailDeliveryQueueName,
		replay: {
			kind: 'unsupported',
			reason: `The worker has no producer binding for ${emailDeliveryQueueName} (Cloudflare Email Service produces it). Ack the message and resend the email instead.`,
		},
	},
	{
		name: artifactsRepoEventsDeadLetterQueueName,
		sourceQueue: artifactsRepoEventsQueueName,
		replay: {
			kind: 'unsupported',
			reason: `The worker has no producer binding for ${artifactsRepoEventsQueueName} (Cloudflare Artifacts event subscriptions produce it). Ack the message; the next repo event re-syncs.`,
		},
	},
	{
		name: platformFeedbackDispatchDeadLetterQueueName,
		sourceQueue: platformFeedbackDispatchQueueName,
		replay: { kind: 'producer', binding: 'PLATFORM_FEEDBACK_DISPATCH_QUEUE' },
	},
	{
		name: communityActivityDispatchDeadLetterQueueName,
		sourceQueue: communityActivityDispatchQueueName,
		replay: { kind: 'producer', binding: 'COMMUNITY_ACTIVITY_DISPATCH_QUEUE' },
	},
	{
		name: communityListingPublishedDispatchDeadLetterQueueName,
		sourceQueue: communityListingPublishedDispatchQueueName,
		replay: {
			kind: 'producer',
			binding: 'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE',
		},
	},
	{
		name: packageEventsDispatchDeadLetterQueueName,
		sourceQueue: packageEventsDispatchQueueName,
		replay: { kind: 'producer', binding: 'PACKAGE_EVENTS_DISPATCH_QUEUE' },
	},
	{
		name: webhookDispatchDeadLetterQueueName,
		sourceQueue: webhookDispatchQueueName,
		replay: { kind: 'producer', binding: 'WEBHOOK_DISPATCH_QUEUE' },
	},
	{
		name: scheduledDispatchDeadLetterQueueName,
		sourceQueue: scheduledDispatchQueueName,
		replay: { kind: 'scheduled-dispatch' },
	},
] as const satisfies ReadonlyArray<DeadLetterQueueDefinition>

export type DeadLetterQueueName = (typeof deadLetterQueues)[number]['name']

export const deadLetterQueueNames = deadLetterQueues.map(
	(queue) => queue.name,
) as [DeadLetterQueueName, ...Array<DeadLetterQueueName>]

export function getDeadLetterQueue(
	name: string,
): DeadLetterQueueDefinition | null {
	return deadLetterQueues.find((queue) => queue.name === name) ?? null
}

/**
 * Matches a batch's deployed queue name to a production DLQ. Preview and test
 * environments prefix the same suffix (`kody-preview-…-dlq`), mirroring
 * deployedQueueMatches in queue-handler.ts.
 */
export function resolveDeadLetterQueue(
	batchQueue: string,
): DeadLetterQueueDefinition | null {
	for (const queue of deadLetterQueues) {
		if (batchQueue === queue.name) return queue
		const suffix = queue.name.slice('kody'.length)
		if (suffix.startsWith('-') && batchQueue.endsWith(suffix)) return queue
	}
	return null
}
