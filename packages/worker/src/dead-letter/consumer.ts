import { describeDeadLetterBody } from './metadata.ts'
import { type DeadLetterQueueDefinition } from './queues.ts'
import { reportDeadLetterFailure } from './report.ts'
import { parkDeadLetterMessage } from './store.ts'

/** Matches max_retries on the DLQ consumers in packages/worker/wrangler.jsonc. */
export const deadLetterConsumerMaxRetries = 100
export const deadLetterConsumerRetryDelaySeconds = 60
/**
 * The DLQs use Cloudflare's default 4-day message retention, so the whole
 * retry schedule has to finish inside it or the queue expires the message
 * before the final (fatal) attempt can report.
 */
export const deadLetterConsumerMaxRetryDelaySeconds = 45 * 60

/**
 * Exponential backoff from 60s to a 45-minute cap: the 100 attempts span about
 * 71 hours of APP_DB outage (inside the 4-day retention) instead of ~100
 * minutes. A message that exhausts its retries is deleted (DLQ consumers have
 * no further DLQ).
 */
export function deadLetterParkRetryDelaySeconds(attempts: number) {
	const exponent = Math.min(Math.max(attempts - 1, 0), 20)
	return Math.min(
		deadLetterConsumerRetryDelaySeconds * 2 ** exponent,
		deadLetterConsumerMaxRetryDelaySeconds,
	)
}

/**
 * Parks every dead-letter message in APP_DB (`dead_letter_messages`) and
 * acks it. Admin capabilities read, replay, ack, and purge the parked rows
 * (docs/contributing/dead-letter-queues.md). A message that cannot be parked
 * is reported to Sentry and retried; it is never acked unparked.
 */
export async function handleDeadLetterQueueBatch(
	batch: MessageBatch<unknown>,
	env: Pick<Env, 'APP_DB'>,
	queue: DeadLetterQueueDefinition,
	now: () => number = Date.now,
) {
	for (const message of batch.messages) {
		try {
			const { bodyJson, metadata } = describeDeadLetterBody(message.body)
			await parkDeadLetterMessage(env.APP_DB, {
				deadLetterQueue: queue.name,
				messageId: message.id,
				sourceQueue: queue.sourceQueue,
				bodyJson,
				metadata,
				attempts: message.attempts,
				enqueuedAtMs: message.timestamp.getTime(),
				parkedAtMs: now(),
			})
			message.ack()
			console.info('dead-letter-message-parked', {
				queue: queue.name,
				messageId: message.id,
				attempts: message.attempts,
				kind: metadata.kind,
				payloadBytes: metadata.payloadBytes,
			})
		} catch (error) {
			reportDeadLetterFailure({
				stage: 'park',
				queue: queue.name,
				messageId: message.id,
				attempts: message.attempts,
				error,
				final: message.attempts > deadLetterConsumerMaxRetries,
			})
			message.retry({
				delaySeconds: deadLetterParkRetryDelaySeconds(message.attempts),
			})
		}
	}
}
