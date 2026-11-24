/**
 * Warning reporter for the jobs Worker's crons and alarms that keep going
 * after a failure on purpose. `kody-custom/no-swallowed-error` accepts a catch
 * that calls it, so a handled failure always leaves a log line with its event
 * name.
 */
export function reportConsumerWarning(
	event: string,
	details: Record<string, unknown>,
) {
	console.warn(event, details)
}
