import type { FleetPackageErrorRateConcentration } from '#universal/fleet-package-error-rate-concentration.ts'

export type { FleetPackageErrorRateConcentration }

export const fleetPackageErrorRateElevatedTopic =
	'fleet.package_error_rate.elevated'

export const fleetPackageErrorRateEventTopics = [
	fleetPackageErrorRateElevatedTopic,
] as const

export const fleetPackageErrorRatePublicStatusUrl = 'https://status.kody.codes'

export type FleetPackageErrorRateElevatedTopic =
	typeof fleetPackageErrorRateElevatedTopic

export type FleetPackageErrorRateWindowKind = 'hour' | 'day'

export type FleetPackageErrorRateElevationReason =
	| 'absolute_delta'
	| 'relative_factor'
	| 'from_zero'

export const fleetPackageErrorRateMetrics = [
	'package_export',
	'package_static_call',
	'job_run',
	'workflow_run',
] as const

export type FleetPackageErrorRateMetric =
	(typeof fleetPackageErrorRateMetrics)[number]

export type FleetPackageErrorRateCounts = {
	events: number
	errors: number
	rate: number | null
}

export type FleetPackageErrorRateWindowSnapshot = {
	start: string
	end: string
	combined: FleetPackageErrorRateCounts
	by_metric: Array<{
		metric: FleetPackageErrorRateMetric
		events: number
		errors: number
		rate: number | null
	}>
}

export type FleetPackageErrorRateElevatedEvent = {
	event: FleetPackageErrorRateElevatedTopic
	event_id: string
	status_url: string
	insights_url: string
	environment: string
	observed_at: string
	trigger: {
		window: FleetPackageErrorRateWindowKind
		reason: FleetPackageErrorRateElevationReason
		recent: FleetPackageErrorRateWindowSnapshot
		previous: FleetPackageErrorRateWindowSnapshot
	}
	by_metric: FleetPackageErrorRateWindowSnapshot['by_metric']
	concentration: FleetPackageErrorRateConcentration | null
}

export function isFleetPackageErrorRateEventTopic(
	value: string,
): value is FleetPackageErrorRateElevatedTopic {
	return (fleetPackageErrorRateEventTopics as ReadonlyArray<string>).includes(
		value,
	)
}

export function buildFleetPackageErrorRateElevatedEvent(input: {
	eventId: string
	statusUrl: string
	insightsUrl: string
	environment: string
	observedAt: string
	window: FleetPackageErrorRateWindowKind
	reason: FleetPackageErrorRateElevationReason
	recent: FleetPackageErrorRateWindowSnapshot
	previous: FleetPackageErrorRateWindowSnapshot
	concentration?: FleetPackageErrorRateConcentration | null
}): FleetPackageErrorRateElevatedEvent {
	return {
		event: fleetPackageErrorRateElevatedTopic,
		event_id: input.eventId,
		status_url: input.statusUrl,
		insights_url: input.insightsUrl,
		environment: input.environment,
		observed_at: input.observedAt,
		trigger: {
			window: input.window,
			reason: input.reason,
			recent: input.recent,
			previous: input.previous,
		},
		by_metric: input.recent.by_metric,
		concentration: input.concentration ?? null,
	}
}

export function buildFleetPackageErrorRateIdempotencyKey(input: {
	event: FleetPackageErrorRateElevatedEvent
	packageId: string
}) {
	return `fleet-package-error-rate:${input.event.event}:${input.event.event_id}:${input.packageId}`
}
