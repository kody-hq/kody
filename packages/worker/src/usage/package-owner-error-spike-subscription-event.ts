import {
	type PackageOwnerSpikeMetricSummary,
	type PackageOwnerSpikePackageSummary,
} from './package-owner-error-spike.ts'

/**
 * Admin audit topic for a package-owner error spike. Fans to admin-owned
 * packages for triage history. Operator notifier packages must not treat
 * this as a page — the owner already received transactional email.
 */
export const packageOwnerErrorSpikeTopic = 'fleet.package_owner_error_spike'

export const packageOwnerErrorSpikeEventTopics = [
	packageOwnerErrorSpikeTopic,
] as const

export type PackageOwnerErrorSpikeTopic = typeof packageOwnerErrorSpikeTopic

export type PackageOwnerErrorSpikeEvent = {
	event: PackageOwnerErrorSpikeTopic
	event_id: string
	insights_url: string
	activity_url: string
	environment: string
	observed_at: string
	owner: {
		username: string
	}
	window: {
		start: string
		end: string
		events: number
		errors: number
		rate: number | null
	}
	spike_started_at: string
	packages: Array<PackageOwnerSpikePackageSummary>
	by_metric: Array<PackageOwnerSpikeMetricSummary>
}

export function isPackageOwnerErrorSpikeEventTopic(
	value: string,
): value is PackageOwnerErrorSpikeTopic {
	return (packageOwnerErrorSpikeEventTopics as ReadonlyArray<string>).includes(
		value,
	)
}

export function buildPackageOwnerErrorSpikeEvent(input: {
	eventId: string
	insightsUrl: string
	activityUrl: string
	environment: string
	observedAt: string
	ownerUsername: string
	windowStart: string
	windowEnd: string
	events: number
	errors: number
	rate: number | null
	spikeStartedAt: string
	packages: Array<PackageOwnerSpikePackageSummary>
	byMetric: Array<PackageOwnerSpikeMetricSummary>
}): PackageOwnerErrorSpikeEvent {
	return {
		event: packageOwnerErrorSpikeTopic,
		event_id: input.eventId,
		insights_url: input.insightsUrl,
		activity_url: input.activityUrl,
		environment: input.environment,
		observed_at: input.observedAt,
		owner: { username: input.ownerUsername },
		window: {
			start: input.windowStart,
			end: input.windowEnd,
			events: input.events,
			errors: input.errors,
			rate: input.rate,
		},
		spike_started_at: input.spikeStartedAt,
		packages: input.packages,
		by_metric: input.byMetric,
	}
}

export function buildPackageOwnerErrorSpikeIdempotencyKey(input: {
	event: PackageOwnerErrorSpikeEvent
	packageId: string
}) {
	return `package-owner-error-spike:${input.event.event}:${input.event.event_id}:${input.packageId}`
}
