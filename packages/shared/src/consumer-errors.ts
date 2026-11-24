/**
 * Reporters for queue consumers, Durable Object alarms, and crons that keep
 * going after a failure on purpose. `kody-custom/no-swallowed-error` accepts
 * a catch that calls one of these, so a handled failure always leaves a log
 * line with its event name.
 */
export function reportConsumerError(
	event: string,
	details: Record<string, unknown>,
) {
	console.error(event, details)
}

export function reportConsumerWarning(
	event: string,
	details: Record<string, unknown>,
) {
	console.warn(event, details)
}
