import { type FleetUsersAffectedWindowMetrics } from './fleet-users-affected.ts'

export const fleetUsersAffectedElevatedTopic = 'fleet.users_affected.elevated'
export const fleetUsersAffectedResolvedTopic = 'fleet.users_affected.resolved'

export const fleetUsersAffectedEventTopics = [
	fleetUsersAffectedElevatedTopic,
	fleetUsersAffectedResolvedTopic,
] as const

export type FleetUsersAffectedElevatedTopic =
	typeof fleetUsersAffectedElevatedTopic
export type FleetUsersAffectedResolvedTopic =
	typeof fleetUsersAffectedResolvedTopic

export type FleetUsersAffectedEventTopic =
	| FleetUsersAffectedElevatedTopic
	| FleetUsersAffectedResolvedTopic

export type FleetUsersAffectedElevatedEvent = {
	event: FleetUsersAffectedElevatedTopic
	event_id: string
	status_url: string
	insights_url: string
	environment: string
	observed_at: string
	incident_started_at: string
	window: {
		start: string
		end: string
		affected_users: number
		active_users: number
		fraction: number | null
	}
	baseline: {
		affected_users_median: number | null
		fraction_median: number | null
	}
	packages: FleetUsersAffectedWindowMetrics['packages']
	by_metric: FleetUsersAffectedWindowMetrics['byMetric']
	dominant_package: FleetUsersAffectedWindowMetrics['dominantPackage']
	deploy: {
		sha: string | null
		timestamp: string | null
	}
}

export type FleetUsersAffectedResolvedEvent = {
	event: FleetUsersAffectedResolvedTopic
	event_id: string
	status_url: string
	insights_url: string
	environment: string
	observed_at: string
	incident_started_at: string | null
	window: {
		start: string
		end: string
		affected_users: number
		active_users: number
		fraction: number | null
	}
	baseline: {
		affected_users_median: number | null
		fraction_median: number | null
	}
}

export type FleetUsersAffectedEvent =
	| FleetUsersAffectedElevatedEvent
	| FleetUsersAffectedResolvedEvent

export const fleetUsersAffectedPublicStatusUrl = 'https://status.kody.codes'

export function isFleetUsersAffectedEventTopic(
	value: string,
): value is FleetUsersAffectedEventTopic {
	return (fleetUsersAffectedEventTopics as ReadonlyArray<string>).includes(
		value,
	)
}

export function buildFleetUsersAffectedElevatedEvent(input: {
	eventId: string
	statusUrl: string
	insightsUrl: string
	environment: string
	observedAt: string
	incidentStartedAt: string
	metrics: FleetUsersAffectedWindowMetrics
	baselineAffectedMedian: number | null
	baselineFractionMedian: number | null
	deploySha: string | null
	deployTimestamp: string | null
}): FleetUsersAffectedElevatedEvent {
	return {
		event: fleetUsersAffectedElevatedTopic,
		event_id: input.eventId,
		status_url: input.statusUrl,
		insights_url: input.insightsUrl,
		environment: input.environment,
		observed_at: input.observedAt,
		incident_started_at: input.incidentStartedAt,
		window: {
			start: input.metrics.windowStart,
			end: input.metrics.windowEnd,
			affected_users: input.metrics.affectedUsers,
			active_users: input.metrics.activeUsers,
			fraction: input.metrics.fraction,
		},
		baseline: {
			affected_users_median: input.baselineAffectedMedian,
			fraction_median: input.baselineFractionMedian,
		},
		packages: input.metrics.packages,
		by_metric: input.metrics.byMetric,
		dominant_package: input.metrics.dominantPackage,
		deploy: {
			sha: input.deploySha,
			timestamp: input.deployTimestamp,
		},
	}
}

export function buildFleetUsersAffectedResolvedEvent(input: {
	eventId: string
	statusUrl: string
	insightsUrl: string
	environment: string
	observedAt: string
	incidentStartedAt: string | null
	metrics: FleetUsersAffectedWindowMetrics
	baselineAffectedMedian: number | null
	baselineFractionMedian: number | null
}): FleetUsersAffectedResolvedEvent {
	return {
		event: fleetUsersAffectedResolvedTopic,
		event_id: input.eventId,
		status_url: input.statusUrl,
		insights_url: input.insightsUrl,
		environment: input.environment,
		observed_at: input.observedAt,
		incident_started_at: input.incidentStartedAt,
		window: {
			start: input.metrics.windowStart,
			end: input.metrics.windowEnd,
			affected_users: input.metrics.affectedUsers,
			active_users: input.metrics.activeUsers,
			fraction: input.metrics.fraction,
		},
		baseline: {
			affected_users_median: input.baselineAffectedMedian,
			fraction_median: input.baselineFractionMedian,
		},
	}
}

export function buildFleetUsersAffectedIdempotencyKey(input: {
	event: FleetUsersAffectedEvent
	packageId: string
}) {
	return `fleet-users-affected:${input.event.event}:${input.event.event_id}:${input.packageId}`
}
