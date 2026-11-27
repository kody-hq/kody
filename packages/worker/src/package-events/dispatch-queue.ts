import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { deliverPackageEvent } from '#worker/package-invocations/service.ts'
import { processInboundDeliveryEffects } from '#worker/email/inbound-effects.ts'
import {
	isInboundDeliveryEffectsQueueBody,
	parseInboundDeliveryEffectsQueueMessage,
} from '#worker/email/inbound-effects-queue.ts'
import {
	deliverWhatsNewConsentOutboxRow,
	isWhatsNewConsentOutboxQueueBody,
	parseWhatsNewConsentOutboxQueueMessage,
} from '#worker/newsletter/consent-outbox.ts'
import {
	deliverSessionCategoryMerged,
	isSessionCategoryMergedQueueBody,
	parseSessionCategoryMergedQueueMessage,
} from '#worker/session-analytics/category-merged-delivery.ts'
import {
	claimPackageEventSlot,
	releasePackageEventSlot,
} from '#worker/run-records/service.ts'
import { ownerCapDeferralDelaySeconds } from '#worker/owner-cap-deferral.ts'
import {
	parsePackageEventsDispatchQueueMessage,
	type PackageEventsDispatchQueueMessage,
} from './dispatch-queue-producer.ts'

const packageEventsDispatchRetryDelaySeconds = 30
/** Matches this consumer's `max_retries` in wrangler.jsonc. */
const packageEventsDispatchMaxRetries = 3

/**
 * How many of one owner's package events are delivered at once. The consumer
 * runs 16 at a time for everyone, so without this one owner's burst holds
 * every slot. Matches `webhookAckOwnerStartedLimit`.
 */
export const packageEventsOwnerInFlightLimit = 4
/** A queue consumer invocation ends within 15 minutes; a killed one frees its slot by then. */
const packageEventSlotTtlMs = 15 * 60 * 1000

export async function handlePackageEventsDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const inboundEffects: Array<Message<unknown>> = []
	const consentOutbox: Array<Message<unknown>> = []
	const categoryMerges: Array<Message<unknown>> = []
	const packageEvents: Array<Message<unknown>> = []
	for (const queueMessage of batch.messages) {
		if (isInboundDeliveryEffectsQueueBody(queueMessage.body)) {
			inboundEffects.push(queueMessage)
		} else if (isWhatsNewConsentOutboxQueueBody(queueMessage.body)) {
			consentOutbox.push(queueMessage)
		} else if (isSessionCategoryMergedQueueBody(queueMessage.body)) {
			categoryMerges.push(queueMessage)
		} else {
			packageEvents.push(queueMessage)
		}
	}
	// Inbound deliveries are independent (each has its own effect lease and
	// per-subscriber idempotency keys), so run them concurrently instead of
	// letting one slow handler delay the rest of the batch.
	await Promise.all([
		Promise.all(
			inboundEffects.map(
				async (queueMessage) =>
					await handleInboundDeliveryEffectsQueueMessage(
						queueMessage,
						env,
						ctx,
					),
			),
		),
		handleWhatsNewConsentOutboxQueueMessages(consentOutbox, env, ctx),
		handleSessionCategoryMergedQueueMessages(categoryMerges, env, ctx),
		handlePackageEventsQueueMessages(packageEvents, env, ctx),
	])
}

// One at a time and in order: two changes for one recipient must reach the
// subscriber in the order they happened.
async function handleWhatsNewConsentOutboxQueueMessages(
	messages: Array<Message<unknown>>,
	env: Env,
	ctx: ExecutionContext,
) {
	for (const queueMessage of messages) {
		const message = parseWhatsNewConsentOutboxQueueMessage(queueMessage.body)
		if (!message) {
			console.error('whats-new-consent-outbox-message-invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		try {
			await deliverWhatsNewConsentOutboxRow({
				env,
				outboxId: message.outboxId,
				waitUntil: (promise) => ctx.waitUntil(promise),
			})
			queueMessage.ack()
		} catch (error) {
			console.error('whats-new-consent-outbox-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				outboxId: message.outboxId,
				error,
			})
			queueMessage.retry({
				delaySeconds: packageEventsDispatchRetryDelaySeconds,
			})
		}
	}
}

/**
 * A failed delivery is retried after `packageEventsDispatchRetryDelaySeconds`
 * until this consumer's `max_retries`, then the Queue dead-letters it.
 */
async function handleSessionCategoryMergedQueueMessages(
	messages: Array<Message<unknown>>,
	env: Env,
	ctx: ExecutionContext,
) {
	for (const queueMessage of messages) {
		const message = parseSessionCategoryMergedQueueMessage(queueMessage.body)
		if (!message) {
			console.error('session-category-merged-message-invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		try {
			await deliverSessionCategoryMerged({
				env,
				event: message.event,
				waitUntil: (promise) => ctx.waitUntil(promise),
			})
			queueMessage.ack()
		} catch (error) {
			console.error('session-category-merged-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				categoryId: message.event.from.id,
				error,
			})
			queueMessage.retry({
				delaySeconds: packageEventsDispatchRetryDelaySeconds,
			})
		}
	}
}

async function handleInboundDeliveryEffectsQueueMessage(
	queueMessage: Message<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const message = parseInboundDeliveryEffectsQueueMessage(queueMessage.body)
	if (!message) {
		console.error('inbound-delivery-effects-message-invalid', {
			queueMessageId: queueMessage.id,
		})
		queueMessage.ack()
		return
	}
	try {
		// Subscription handler failures are recorded on the delivery's effect
		// ledger (retry or dead-letter) inside processInboundDeliveryEffects;
		// only failures before that bookkeeping throw here.
		await processInboundDeliveryEffects({
			env,
			userId: message.userId,
			deliveryId: message.deliveryId,
			expectedFinalizationToken: message.expectedFinalizationToken,
			durationMs: message.durationMs,
			waitUntil: (promise) => ctx.waitUntil(promise),
		})
		queueMessage.ack()
	} catch (error) {
		console.error('inbound-delivery-effects-queue-processing-failed', {
			queueMessageId: queueMessage.id,
			userId: message.userId,
			deliveryId: message.deliveryId,
			error,
		})
		queueMessage.retry({
			delaySeconds: packageEventsDispatchRetryDelaySeconds,
		})
	}
}

async function handlePackageEventsQueueMessages(
	messages: Array<Message<unknown>>,
	env: Env,
	ctx: ExecutionContext,
) {
	if (messages.length === 0) return
	const baseUrl = getAppBaseUrl({ env })
	for (const queueMessage of messages) {
		const message = parsePackageEventsDispatchQueueMessage(queueMessage.body)
		if (!message) {
			console.error('package-events-dispatch-message-invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		if (
			failedAttempts(queueMessage, message) > packageEventsDispatchMaxRetries
		) {
			// Out of retries, counting those before it was put back. Only the
			// Queue can dead-letter, so retry without delivering until it does.
			queueMessage.retry()
			continue
		}
		const { claimed } = await claimPackageEventSlot({
			env,
			userId: message.userId,
			id: queueMessage.id,
			limit: packageEventsOwnerInFlightLimit,
			expiresAt: new Date(Date.now() + packageEventSlotTtlMs).toISOString(),
		})
		if (!claimed) {
			await deferPackageEvent(queueMessage, message, env)
			continue
		}
		try {
			const result = await deliverPackageEvent({
				env,
				baseUrl,
				message,
				waitUntil: (promise) => ctx.waitUntil(promise),
			})
			// Terminal handler failures are final for this delivery: the
			// idempotency ledger would replay the stored failure on retry, so
			// redelivery cannot help. They stay visible in each subscriber's
			// run records.
			if (result.failed > 0) {
				console.error('package-events-dispatch-subscribers-failed', {
					queueMessageId: queueMessage.id,
					topic: message.topic,
					sourcePackageId: message.source.packageId,
					failed: result.failed,
					delivered: result.delivered,
				})
			}
			queueMessage.ack()
		} catch (error) {
			console.error('package-events-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				topic: message.topic,
				sourcePackageId: message.source.packageId,
				error,
			})
			queueMessage.retry({
				delaySeconds: packageEventsDispatchRetryDelaySeconds,
			})
		} finally {
			await releasePackageEventSlot({
				env,
				userId: message.userId,
				id: queueMessage.id,
			})
		}
	}
}

/**
 * Put an event back because its owner is at the cap. It is re-sent, because
 * retry() counts toward max_retries and a long wait behind the owner's own
 * backlog would dead-letter a healthy event. The re-sent message starts the
 * Queue's attempt count over, so it carries the failures so far.
 */
async function deferPackageEvent(
	queueMessage: Message<unknown>,
	message: PackageEventsDispatchQueueMessage,
	env: Env,
) {
	const deferrals = message.deferrals ?? 0
	const priorAttempts = failedAttempts(queueMessage, message)
	try {
		await env.PACKAGE_EVENTS_DISPATCH_QUEUE.send(
			{
				...message,
				deferrals: deferrals + 1,
				...(priorAttempts > 0 ? { priorAttempts } : {}),
			} satisfies PackageEventsDispatchQueueMessage,
			{ delaySeconds: ownerCapDeferralDelaySeconds(deferrals) },
		)
		queueMessage.ack()
	} catch (error) {
		console.error('package-events-dispatch-deferral-send-failed', {
			queueMessageId: queueMessage.id,
			topic: message.topic,
			error,
		})
		queueMessage.retry({
			delaySeconds: packageEventsDispatchRetryDelaySeconds,
		})
	}
}

/** Deliveries of this event that failed, across every time it was put back. */
function failedAttempts(
	queueMessage: Message<unknown>,
	message: PackageEventsDispatchQueueMessage,
) {
	return (message.priorAttempts ?? 0) + queueMessage.attempts - 1
}
