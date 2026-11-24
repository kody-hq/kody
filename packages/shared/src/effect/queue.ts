import { Cause, Effect } from 'effect'

/**
 * What a queue consumer decided for one message. `afterAck` runs only once
 * the message is acked; its failure is logged, never raised.
 */
export type QueueDisposition =
	| { readonly kind: 'ack'; readonly afterAck?: Effect.Effect<void, unknown> }
	| { readonly kind: 'retry'; readonly delaySeconds: number }

export type SettleableQueueMessage = {
	readonly id: string
	ack(): void
	retry(options?: { delaySeconds?: number }): void
}

/**
 * Decides and settles every message in a batch, each exactly once. A failed
 * or defected decision goes to `onDecideFailure`; if that fails too, the
 * message is retried after `failureRetryDelaySeconds`. `concurrency` (default
 * 1, batch order) is the consumer's backpressure on its downstream.
 */
export const settleQueueBatch = <
	Message extends SettleableQueueMessage,
	E,
>(input: {
	readonly consumer: string
	readonly messages: ReadonlyArray<Message>
	readonly decide: (message: Message) => Effect.Effect<QueueDisposition, E>
	readonly onDecideFailure: (
		message: Message,
		error: unknown,
	) => Effect.Effect<QueueDisposition, unknown>
	readonly failureRetryDelaySeconds: number
	readonly concurrency?: number
}): Effect.Effect<void> => {
	const settle = (message: Message) =>
		input.decide(message).pipe(
			Effect.catchCause((cause) =>
				input.onDecideFailure(message, Cause.squash(cause)),
			),
			Effect.flatMap((disposition) => {
				if (disposition.kind === 'retry') {
					return Effect.sync(() =>
						message.retry({ delaySeconds: disposition.delaySeconds }),
					)
				}
				return (disposition.afterAck ?? Effect.void).pipe(
					Effect.catchCause((cause) =>
						Effect.logError(`${input.consumer}-after-ack-failed`, {
							queueMessageId: message.id,
							error: Cause.squash(cause),
						}),
					),
					Effect.andThen(Effect.sync(() => message.ack())),
				)
			}),
			Effect.catchCause((cause) =>
				Effect.logError(`${input.consumer}-failure-handling-failed`, {
					queueMessageId: message.id,
					error: Cause.squash(cause),
				}),
			),
			Effect.withSpan(`${input.consumer}.message`, {
				attributes: { 'kody.queue_message_id': message.id },
			}),
		)
	return Effect.forEach(input.messages, settle, {
		concurrency: Math.max(1, input.concurrency ?? 1),
		discard: true,
	}).pipe(Effect.withSpan(`${input.consumer}.batch`))
}
