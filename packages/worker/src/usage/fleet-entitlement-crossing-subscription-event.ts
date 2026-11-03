import { isoTimestampDayKey } from '@kody-internal/shared/date-keys.ts'
import type { AdminUsageEntitlementResource } from '#universal/loader-data.ts'

export const fleetEntitlementCrossedTopic = 'fleet.entitlement.crossed'

export const fleetEntitlementCrossingEventTopics = [
	fleetEntitlementCrossedTopic,
] as const

export type FleetEntitlementCrossedTopic = typeof fleetEntitlementCrossedTopic

export const fleetEntitlementCrossingThresholds = [
	'approaching',
	'reached',
] as const

export type FleetEntitlementCrossingThreshold =
	(typeof fleetEntitlementCrossingThresholds)[number]

export type FleetEntitlementCrossingKind =
	| 'entitlement'
	| 'runtime_duration'
	| 'repeated_entitlement'
	| 'dynamic_worker_cost'

export type FleetEntitlementCrossingUser = {
	id: string
	username: string
}

export type FleetEntitlementResourceCrossedEvent = {
	event: FleetEntitlementCrossedTopic
	kind: 'entitlement'
	user: FleetEntitlementCrossingUser
	resource: AdminUsageEntitlementResource
	label: string
	threshold: FleetEntitlementCrossingThreshold
	current: number
	limit: number
	percent_of_limit: number
	insights_url: string
	users_url: string
	observed_at: string
}

export type FleetRuntimeDurationCrossedEvent = {
	event: FleetEntitlementCrossedTopic
	kind: 'runtime_duration'
	user: FleetEntitlementCrossingUser
	total_duration_ms: number
	threshold_ms: number
	insights_url: string
	users_url: string
	observed_at: string
}

export type FleetRepeatedEntitlementCrossedEvent = {
	event: FleetEntitlementCrossedTopic
	kind: 'repeated_entitlement'
	user: FleetEntitlementCrossingUser
	resource: AdminUsageEntitlementResource
	days_at_limit: number
	window_days: number
	threshold_days: number
	insights_url: string
	users_url: string
	observed_at: string
}

export type FleetDynamicWorkerCostCrossedEvent = {
	event: FleetEntitlementCrossedTopic
	kind: 'dynamic_worker_cost'
	user: FleetEntitlementCrossingUser
	unique_worker_days: number
	estimated_gross_usd: number
	threshold_usd: number
	insights_url: string
	users_url: string
	observed_at: string
}

export type FleetEntitlementCrossedEvent =
	| FleetEntitlementResourceCrossedEvent
	| FleetRuntimeDurationCrossedEvent
	| FleetRepeatedEntitlementCrossedEvent
	| FleetDynamicWorkerCostCrossedEvent

export function isFleetEntitlementCrossingEventTopic(
	value: string,
): value is FleetEntitlementCrossedTopic {
	return (
		fleetEntitlementCrossingEventTopics as ReadonlyArray<string>
	).includes(value)
}

export function buildFleetEntitlementResourceCrossedEvent(input: {
	user: FleetEntitlementCrossingUser
	resource: AdminUsageEntitlementResource
	label: string
	threshold: FleetEntitlementCrossingThreshold
	current: number
	limit: number
	percentOfLimit: number
	insightsUrl: string
	usersUrl: string
	observedAt: string
}): FleetEntitlementResourceCrossedEvent {
	return {
		event: fleetEntitlementCrossedTopic,
		kind: 'entitlement',
		user: input.user,
		resource: input.resource,
		label: input.label,
		threshold: input.threshold,
		current: input.current,
		limit: input.limit,
		percent_of_limit: input.percentOfLimit,
		insights_url: input.insightsUrl,
		users_url: input.usersUrl,
		observed_at: input.observedAt,
	}
}

export function buildFleetRuntimeDurationCrossedEvent(input: {
	user: FleetEntitlementCrossingUser
	totalDurationMs: number
	thresholdMs: number
	insightsUrl: string
	usersUrl: string
	observedAt: string
}): FleetRuntimeDurationCrossedEvent {
	return {
		event: fleetEntitlementCrossedTopic,
		kind: 'runtime_duration',
		user: input.user,
		total_duration_ms: input.totalDurationMs,
		threshold_ms: input.thresholdMs,
		insights_url: input.insightsUrl,
		users_url: input.usersUrl,
		observed_at: input.observedAt,
	}
}

export function buildFleetRepeatedEntitlementCrossedEvent(input: {
	user: FleetEntitlementCrossingUser
	resource: AdminUsageEntitlementResource
	daysAtLimit: number
	windowDays: number
	thresholdDays: number
	insightsUrl: string
	usersUrl: string
	observedAt: string
}): FleetRepeatedEntitlementCrossedEvent {
	return {
		event: fleetEntitlementCrossedTopic,
		kind: 'repeated_entitlement',
		user: input.user,
		resource: input.resource,
		days_at_limit: input.daysAtLimit,
		window_days: input.windowDays,
		threshold_days: input.thresholdDays,
		insights_url: input.insightsUrl,
		users_url: input.usersUrl,
		observed_at: input.observedAt,
	}
}

export function buildFleetDynamicWorkerCostCrossedEvent(input: {
	user: FleetEntitlementCrossingUser
	uniqueWorkerDays: number
	estimatedGrossUsd: number
	thresholdUsd: number
	insightsUrl: string
	usersUrl: string
	observedAt: string
}): FleetDynamicWorkerCostCrossedEvent {
	return {
		event: fleetEntitlementCrossedTopic,
		kind: 'dynamic_worker_cost',
		user: input.user,
		unique_worker_days: input.uniqueWorkerDays,
		estimated_gross_usd: input.estimatedGrossUsd,
		threshold_usd: input.thresholdUsd,
		insights_url: input.insightsUrl,
		users_url: input.usersUrl,
		observed_at: input.observedAt,
	}
}

export function buildFleetEntitlementCrossingIdempotencyKey(input: {
	event: FleetEntitlementCrossedEvent
	packageId: string
}) {
	switch (input.event.kind) {
		case 'entitlement': {
			const dailySuffix = input.event.resource.endsWith('_per_day')
				? `:${isoTimestampDayKey(input.event.observed_at)}`
				: ''
			return `fleet-entitlement-crossing:${input.event.event}:${input.event.user.id}:${input.event.kind}:${input.event.threshold}:${input.event.resource}${dailySuffix}:${input.packageId}`
		}
		case 'runtime_duration':
			return `fleet-entitlement-crossing:${input.event.event}:${input.event.user.id}:${input.event.kind}:${input.event.observed_at.slice(0, 7)}:${input.packageId}`
		case 'repeated_entitlement':
			return `fleet-entitlement-crossing:${input.event.event}:${input.event.user.id}:${input.event.kind}:${input.event.resource}:${isoTimestampDayKey(input.event.observed_at)}:${input.packageId}`
		case 'dynamic_worker_cost':
			return `fleet-entitlement-crossing:${input.event.event}:${input.event.user.id}:${input.event.kind}:${input.event.observed_at.slice(0, 7)}:${input.packageId}`
		default: {
			const exhaustive: never = input.event
			throw new Error(
				`Unsupported fleet entitlement crossing: ${String(exhaustive)}`,
			)
		}
	}
}
