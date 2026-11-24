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

/**
 * Decides and settles every message in a batch. Each message is acked or
 * retried exactly once: a thrown decision becomes `onDecideFailure`'s
 * disposition, and a retry after `failureRetryDelaySeconds` when that throws
 * too. `concurrency` caps how many messages are in flight (default 1, in
 * batch order), which is the consumer's backpressure on its downstream.
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
		switch (disposition.kind) {
			case 'ack': {
				message.ack()
				if (!disposition.afterAck) return
				try {
					await disposition.afterAck()
				} catch (error) {
					reportConsumerError(`${input.consumer}-after-ack-failed`, {
						queueMessageId: message.id,
						error,
					})
				}
				return
			}
			case 'retry':
				message.retry({ delaySeconds: disposition.delaySeconds })
				return
			default:
				assertNever(disposition)
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
	const lanes = Math.min(
		Math.max(1, input.concurrency ?? 1),
		input.messages.length,
	)
	await Promise.all(Array.from({ length: lanes }, lane))
}
