import { handleDeadLetterQueueBatch } from '#worker/dead-letter/consumer.ts'
import { resolveDeadLetterQueue } from '#worker/dead-letter/queues.ts'
import {
	emailDeliveryQueueName,
	handleEmailDeliveryQueue,
} from '#worker/email/delivery-queue.ts'
import { handleCommunityActivityDispatchQueue } from '#worker/community/activity-dispatch-queue.ts'
import { communityActivityDispatchQueueName } from '#worker/community/activity-dispatch-queue-names.ts'
import { handleCommunityListingPublishedDispatchQueue } from '#worker/community/listing-published-dispatch-queue.ts'
import { communityListingPublishedDispatchQueueName } from '#worker/community/listing-published-dispatch-queue-names.ts'
import { handlePlatformFeedbackDispatchQueue } from '#worker/platform-feedback/dispatch-queue.ts'
import { platformFeedbackDispatchQueueName } from '#worker/platform-feedback/dispatch-queue-names.ts'
import { handlePackageEventsDispatchQueue } from '#worker/package-events/dispatch-queue.ts'
import { packageEventsDispatchQueueName } from '#worker/package-events/dispatch-queue-names.ts'
import {
	artifactsRepoEventsQueueName,
	handleArtifactsRepoEventsQueue,
} from '#worker/repo/artifacts-event-queue.ts'
import {
	handleWebhookDispatchQueue,
	webhookDispatchQueueName,
} from '#worker/webhooks/dispatch-queue.ts'

const unknownQueueRetryDelaySeconds = 30

/**
 * Production queues are `kody-<suffix>`. Preview copies are
 * `<worker><suffix>` (`kody-pr-42-platform-feedback-dispatch`). The suffix
 * stays at the end even when the worker name is truncated.
 */
export function deployedQueueMatches(
	batchQueue: string,
	productionQueueName: string,
) {
	if (batchQueue === productionQueueName) return true
	const suffix = productionQueueName.slice('kody'.length)
	return suffix.startsWith('-') && batchQueue.endsWith(suffix)
}

type KnownWorkerQueue =
	| 'email-delivery'
	| 'artifacts-repo-events'
	| 'platform-feedback'
	| 'community-activity'
	| 'community-listing-published'
	| 'package-events'
	| 'webhook'

function resolveWorkerQueue(batchQueue: string): KnownWorkerQueue | null {
	if (deployedQueueMatches(batchQueue, emailDeliveryQueueName)) {
		return 'email-delivery'
	}
	if (deployedQueueMatches(batchQueue, artifactsRepoEventsQueueName)) {
		return 'artifacts-repo-events'
	}
	if (deployedQueueMatches(batchQueue, platformFeedbackDispatchQueueName)) {
		return 'platform-feedback'
	}
	if (deployedQueueMatches(batchQueue, communityActivityDispatchQueueName)) {
		return 'community-activity'
	}
	if (
		deployedQueueMatches(batchQueue, communityListingPublishedDispatchQueueName)
	) {
		return 'community-listing-published'
	}
	if (deployedQueueMatches(batchQueue, packageEventsDispatchQueueName)) {
		return 'package-events'
	}
	if (deployedQueueMatches(batchQueue, webhookDispatchQueueName)) {
		return 'webhook'
	}
	return null
}

export async function handleQueueBatch(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const deadLetterQueue = resolveDeadLetterQueue(batch.queue)
	if (deadLetterQueue) {
		await handleDeadLetterQueueBatch(batch, env, deadLetterQueue)
		return
	}
	const kind = resolveWorkerQueue(batch.queue)
	switch (kind) {
		case 'email-delivery':
			await handleEmailDeliveryQueue(batch, env, ctx)
			return
		case 'artifacts-repo-events':
			await handleArtifactsRepoEventsQueue(batch, env, ctx)
			return
		case 'platform-feedback':
			await handlePlatformFeedbackDispatchQueue(batch, env, ctx)
			return
		case 'community-activity':
			await handleCommunityActivityDispatchQueue(batch, env, ctx)
			return
		case 'community-listing-published':
			await handleCommunityListingPublishedDispatchQueue(batch, env, ctx)
			return
		case 'package-events':
			await handlePackageEventsDispatchQueue(batch, env, ctx)
			return
		case 'webhook':
			await handleWebhookDispatchQueue(batch, env)
			return
		case null:
			console.error('unknown-worker-queue', { queue: batch.queue })
			batch.retryAll({ delaySeconds: unknownQueueRetryDelaySeconds })
			return
		default: {
			const unhandled: never = kind
			throw new Error(`Unhandled worker queue ${String(unhandled)}`)
		}
	}
}
