import { Effect, Option } from 'effect'
import {
	decodeWhatsNewConsentOutboxMessage,
	deliverWhatsNewConsentOutboxRow,
} from './consent-outbox.ts'
import { consentOutboxConsumerLayer } from './entrypoints.ts'

/**
 * `PACKAGE_EVENTS_DISPATCH_QUEUE` consumer for consent outbox messages, one at
 * a time and in order: two changes for one recipient must reach the
 * subscriber in the order they happened.
 */
export async function handleWhatsNewConsentOutboxQueueMessages(
	messages: Array<Message<unknown>>,
	env: Env,
	ctx: ExecutionContext,
	retryDelaySeconds: number,
) {
	const handleMessage = Effect.fn('whatsNewConsentOutbox.handleMessage')(
		function* (queueMessage: Message<unknown>) {
			const message = decodeWhatsNewConsentOutboxMessage(queueMessage.body)
			if (Option.isNone(message)) {
				yield* Effect.logError('whats-new-consent-outbox-message-invalid', {
					queueMessageId: queueMessage.id,
				})
				return queueMessage.ack()
			}
			const { outboxId } = message.value
			yield* deliverWhatsNewConsentOutboxRow(outboxId).pipe(
				Effect.matchCauseEffect({
					onSuccess: () => Effect.sync(() => queueMessage.ack()),
					onFailure: (cause) =>
						Effect.logError(
							'whats-new-consent-outbox-queue-processing-failed',
							{ queueMessageId: queueMessage.id, outboxId },
							cause,
						).pipe(
							Effect.andThen(
								Effect.sync(() =>
									queueMessage.retry({
										delaySeconds: retryDelaySeconds,
									}),
								),
							),
						),
				}),
			)
		},
	)
	await Effect.forEach(messages, handleMessage, { discard: true }).pipe(
		Effect.provide(
			consentOutboxConsumerLayer(env, (promise) => ctx.waitUntil(promise)),
		),
		Effect.runPromise,
	)
}
