import * as Sentry from '@sentry/cloudflare'

/**
 * Reporters for queue consumers, Durable Object alarms, and crons that keep
 * going after a failure on purpose. `kody-custom/no-swallowed-error` accepts
 * a catch that calls one of these, so a handled failure always leaves a log
 * line with its event name. Errors also go to Sentry, tagged with the event,
 * because nothing upstream sees a failure the consumer already settled.
 */
export function reportConsumerError(
	event: string,
	details: Record<string, unknown>,
) {
	console.error(event, details)
	const { error, ...context } = details
	Sentry.withScope((scope) => {
		scope.setTag('queue_consumer.event', event)
		scope.setContext('queue_consumer', context)
		if (error === undefined) Sentry.captureMessage(event, 'error')
		else Sentry.captureException(error)
	})
}

export function reportConsumerWarning(
	event: string,
	details: Record<string, unknown>,
) {
	console.warn(event, details)
}
