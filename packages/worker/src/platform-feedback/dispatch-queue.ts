import * as Sentry from '@sentry/cloudflare'
import { sendPlatformFeedbackAcknowledgementEmail } from './acknowledgement-email.ts'
import type { PlatformFeedbackDispatchQueueMessage } from './dispatch-queue-producer.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'
import { dispatchPlatformFeedbackSubmittedSubscriptionEvent } from './package-subscriptions.ts'
import { getPlatformFeedbackForAdmin } from './service.ts'

const platformFeedbackDispatchRetryDelaySeconds = 30

function parsePlatformFeedbackDispatchQueueMessage(
	body: unknown,
): PlatformFeedbackDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const record = body as Record<string, unknown>
	const feedbackId = record['feedbackId']
	if (
		Object.keys(record).length !== 1 ||
		typeof feedbackId !== 'string' ||
		!feedbackId.trim()
	) {
		return null
	}
	return { feedbackId: feedbackId.trim() }
}

/**
 * Best-effort submit receipt. Runs on the shared dispatch queue so every submit
 * path gets it without blocking insert or admin enqueue. Failures never fail
 * the queue message (package fan-out owns retry).
 */
async function sendPlatformFeedbackAcknowledgementBestEffort(input: {
	env: Env
	feedbackId: string
}) {
	try {
		const feedback = await getPlatformFeedbackForAdmin({
			db: input.env.APP_DB,
			feedbackId: input.feedbackId,
		})
		if (!feedback) return
		await sendPlatformFeedbackAcknowledgementEmail({
			env: input.env,
			feedback,
		})
	} catch (error) {
		console.warn('platform-feedback-acknowledgement-email-failed', {
			feedbackId: input.feedbackId,
			error,
		})
		try {
			Sentry.captureException(error, {
				tags: { scope: 'platform-feedback-acknowledgement-email' },
				extra: { feedbackId: input.feedbackId },
			})
		} catch {
			// ignore Sentry bootstrap failures
		}
	}
}

export async function handlePlatformFeedbackDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
) {
	for (const queueMessage of batch.messages) {
		const parsed = parsePlatformFeedbackDispatchQueueMessage(queueMessage.body)
		if (!parsed) {
			queueMessage.ack()
			continue
		}
		// Start the receipt in parallel with admin fan-out so a slow email
		// provider cannot delay package subscription dispatch.
		const acknowledgement = sendPlatformFeedbackAcknowledgementBestEffort({
			env,
			feedbackId: parsed.feedbackId,
		})
		try {
			await dispatchPlatformFeedbackSubmittedSubscriptionEvent({
				env,
				feedbackId: parsed.feedbackId,
			})
			queueMessage.ack()
		} catch (error) {
			if (error instanceof PlatformFeedbackDispatchCancelledError) {
				queueMessage.ack()
				continue
			}
			console.error('platform-feedback-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				feedbackId: parsed.feedbackId,
				error,
			})
			queueMessage.retry({
				delaySeconds: platformFeedbackDispatchRetryDelaySeconds,
			})
		} finally {
			await acknowledgement
		}
	}
}
