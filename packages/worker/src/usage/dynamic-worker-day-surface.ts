/**
 * Closed surface tags for unique Dynamic Worker day (UWD) attribution.
 *
 * Cloudflare bills unique Dynamic Worker ids per UTC day. The `execute`
 * usage metric is MCP-execute-only, and jobs already emit `job_run`; UWD
 * itself had no surface. Every LOADER mint records this tag on the
 * `dynamic_worker_day` usage event so Analytics Engine can break the
 * month down by surface.
 *
 * `package_export` is the usage-metering name for run-record surface
 * `export`. Fail closed to `unknown` only when no run surface or package
 * context is available.
 */

import { type RunSurface } from '#worker/run-records/types.ts'

export const dynamicWorkerDaySurfaces = [
	'execute',
	'job',
	'package_export',
	'workflow',
	'subscription',
	'app_fetch',
	'app_realtime',
	'webhook',
	'unknown',
] as const

export type DynamicWorkerDaySurface = (typeof dynamicWorkerDaySurfaces)[number]

const runSurfaceToDynamicWorkerDaySurface = {
	execute: 'execute',
	export: 'package_export',
	job: 'job',
	workflow: 'workflow',
	subscription: 'subscription',
	app_fetch: 'app_fetch',
	app_realtime: 'app_realtime',
	webhook: 'webhook',
} as const satisfies Record<RunSurface, DynamicWorkerDaySurface>

export function isDynamicWorkerDaySurface(
	value: string,
): value is DynamicWorkerDaySurface {
	return (dynamicWorkerDaySurfaces as ReadonlyArray<string>).includes(value)
}

/**
 * Map a run-record surface onto the UWD tag. Missing or unexpected values
 * become `unknown` so a new run surface cannot silently mint an untagged
 * day — add the mapping in the same change as the run surface.
 */
export function dynamicWorkerDaySurfaceFromRunSurface(
	surface: RunSurface | null | undefined,
): DynamicWorkerDaySurface {
	if (!surface) return 'unknown'
	switch (surface) {
		case 'execute':
		case 'export':
		case 'job':
		case 'workflow':
		case 'subscription':
		case 'app_fetch':
		case 'app_realtime':
		case 'webhook':
			return runSurfaceToDynamicWorkerDaySurface[surface]
		default: {
			const exhaustive: never = surface
			void exhaustive
			return 'unknown'
		}
	}
}

/**
 * Surface used for UWD / execute-usage when the registry may not own the
 * run record. Prefer the begun record, then a pre-claimed handle, then an
 * explicit `runSurface` from a caller that finishes the record itself
 * (keyed package invocations, inline workflows).
 */
export function resolveObservedRunSurface(input: {
	surface?: RunSurface | null
	handleSurface?: RunSurface | null
	runSurface?: RunSurface | null
}): RunSurface | null {
	return input.surface ?? input.handleSurface ?? input.runSurface ?? null
}

/**
 * Prefer the observed run surface. A missing surface with package context
 * is a bundled package export; a missing surface without one is ad-hoc
 * execute — the same inference as `shouldRecordExecuteUsageForRun`.
 */
export function resolveDynamicWorkerDaySurface(input: {
	surface?: RunSurface | null
	handleSurface?: RunSurface | null
	runSurface?: RunSurface | null
	hasPackageContext: boolean
}): DynamicWorkerDaySurface {
	const fromRun = dynamicWorkerDaySurfaceFromRunSurface(
		resolveObservedRunSurface(input),
	)
	if (fromRun !== 'unknown') return fromRun
	if (input.hasPackageContext) return 'package_export'
	return 'execute'
}
