import type { FleetPackageErrorRateConcentration } from '#universal/fleet-package-error-rate-concentration.ts'

export type { FleetPackageErrorRateConcentration }

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
