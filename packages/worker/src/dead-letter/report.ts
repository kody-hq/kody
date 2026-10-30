import * as Sentry from '@sentry/cloudflare'

export type DeadLetterFailureStage = 'park' | 'replay' | 'ack' | 'purge'

/**
 * Reports a dead-letter handling failure to Sentry with the queue, message
 * id, and attempt count. Never attaches the message body.
 */
export function reportDeadLetterFailure(input: {
	stage: DeadLetterFailureStage
	queue: string
	messageId?: string | null
	attempts?: number | null
	error: unknown
	/** The message will be dropped by Cloudflare after this failure. */
	final?: boolean
}) {
	const errorMessage =
		input.error instanceof Error ? input.error.message : String(input.error)
	console.error('dead-letter-handling-failed', {
		stage: input.stage,
		queue: input.queue,
		messageId: input.messageId ?? null,
		attempts: input.attempts ?? null,
		final: input.final ?? false,
		error: errorMessage,
	})
	Sentry.withScope((scope) => {
		scope.setLevel(input.final ? 'fatal' : 'error')
		scope.setTag('dead_letter.stage', input.stage)
		scope.setTag('queue.name', input.queue)
		scope.setFingerprint(['dead-letter-handling', input.stage, input.queue])
		scope.setContext('dead_letter', {
			stage: input.stage,
			queue: input.queue,
			messageId: input.messageId ?? null,
			attempts: input.attempts ?? null,
			final: input.final ?? false,
			error: errorMessage,
		})
		Sentry.captureException(
			input.error instanceof Error ? input.error : new Error(errorMessage),
		)
	})
}
