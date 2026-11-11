import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { deliverPackageEvent } from '#worker/package-invocations/service.ts'
import { processInboundDeliveryEffects } from '#worker/email/inbound-effects.ts'
import {
	isInboundDeliveryEffectsQueueBody,
	parseInboundDeliveryEffectsQueueMessage,
} from '#worker/email/inbound-effects-queue.ts'
import { parsePackageEventsDispatchQueueMessage } from './dispatch-queue-producer.ts'

const packageEventsDispatchRetryDelaySeconds = 30

export async function handlePackageEventsDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	ctx: ExecutionContext,
) {
	const inboundEffects: Array<Message<unknown>> = []
	const packageEvents: Array<Message<unknown>> = []
	for (const queueMessage of batch.messages) {
		if (isInboundDeliveryEffectsQueueBody(queueMessage.body)) {
			inboundEffects.push(queueMessage)
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
		handlePackageEventsQueueMessages(packageEvents, env, ctx),
	])
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
		}
	}
}
