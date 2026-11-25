import { reportConsumerError } from './consumer-errors.ts'

/**
 * What a queue consumer decided for one message. `settleQueueBatch` applies
 * it exactly once. `afterAck` is cleanup that must only run once the message
 * is acked (for example deleting a spilled payload); its failure is reported,
 * never thrown.
 */
export type QueueDisposition =
	| { kind: 'ack'; afterAck?: () => Promise<void> }
	| { kind: 'retry'; delaySeconds: number }

export type SettleableQueueMessage = {
	readonly id: string
	ack(): void
	retry(options?: { delaySeconds?: number }): void
}

function assertNever(value: never): never {
	throw new Error(`Unhandled queue disposition: ${JSON.stringify(value)}`)
}

/** Cloudflare Queues rejects a retry delay above 12 hours. */
const maxRetryDelaySeconds = 12 * 60 * 60

function retryDelaySeconds(delaySeconds: number) {
	if (!Number.isFinite(delaySeconds) || delaySeconds < 0) return 0
	return Math.min(Math.ceil(delaySeconds), maxRetryDelaySeconds)
}

function applyDisposition(
	message: SettleableQueueMessage,
	disposition: QueueDisposition,
) {
	switch (disposition.kind) {
		case 'ack':
			message.ack()
			return
		case 'retry':
			message.retry({
				delaySeconds: retryDelaySeconds(disposition.delaySeconds),
			})
			return
		default:
			assertNever(disposition)
	}
}

/**
 * Decides and settles every message in a batch, acking or retrying each once.
 *
 * - Failure fallback: a thrown `decide` calls `onDecideFailure`; if that also
 *   throws, the message retries after `failureRetryDelaySeconds`.
 * - Concurrency: `concurrency` caps in-flight messages (default `1`, in batch
 *   order; non-finite values fall back to `1`) for downstream backpressure.
 * - Resilience: retry delays clamp to `0..12h`, and a throwing `ack()` or
 *   `retry()` is reported without stopping the rest of the batch.
 */
export async function settleQueueBatch<
	Message extends SettleableQueueMessage,
>(input: {
	consumer: string
	messages: ReadonlyArray<Message>
	decide: (message: Message) => Promise<QueueDisposition>
	onDecideFailure: (
		message: Message,
		error: unknown,
	) => Promise<QueueDisposition>
	failureRetryDelaySeconds: number
	concurrency?: number
}): Promise<void> {
	const decideOrFallBack = async (
		message: Message,
	): Promise<QueueDisposition> => {
		try {
			return await input.decide(message)
		} catch (error) {
			try {
				return await input.onDecideFailure(message, error)
			} catch (fallbackError) {
				reportConsumerError(`${input.consumer}-failure-handling-failed`, {
					queueMessageId: message.id,
					error: fallbackError,
				})
				return { kind: 'retry', delaySeconds: input.failureRetryDelaySeconds }
			}
		}
	}
	const settle = async (message: Message) => {
		const disposition = await decideOrFallBack(message)
		try {
			applyDisposition(message, disposition)
		} catch (error) {
			// A throwing ack() or retry() must not stop this lane: the runtime
			// redelivers the message, and every later message still settles.
			reportConsumerError(`${input.consumer}-settle-failed`, {
				queueMessageId: message.id,
				disposition: disposition.kind,
				error,
			})
			return
		}
		if (disposition.kind !== 'ack' || !disposition.afterAck) return
		try {
			await disposition.afterAck()
		} catch (error) {
			reportConsumerError(`${input.consumer}-after-ack-failed`, {
				queueMessageId: message.id,
				error,
			})
		}
	}
	let next = 0
	const lane = async () => {
		// Exit: every lane stops once the shared cursor passes the last message.
		while (next < input.messages.length) {
			const message = input.messages[next]!
			next += 1
			await settle(message)
		}
	}
	const requested = input.concurrency ?? 1
	const lanes = Math.min(
		Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1,
		input.messages.length,
	)
	await Promise.all(Array.from({ length: lanes }, lane))
}
