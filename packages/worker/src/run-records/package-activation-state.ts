/**
 * Per-user package-activation counters and milestones stored in the RunLog DO.
 *
 * The Durable Object identity provides the user scope, so records do not need
 * a `user_id`. High-frequency HTTP surfaces do not count; activation means an
 * unattended capability succeeded twice for the same package.
 */

import type { RunSurface } from './types.ts'

export type ActivationMilestone = 'package_run_succeeded' | 'package_activated'

export const activationMilestoneValues = [
	'package_run_succeeded',
	'package_activated',
] as const satisfies ReadonlyArray<ActivationMilestone>

export type PackageRunSuccessRecord = {
	packageId: string
	successCount: number
	updatedAt: string
}

export type ActivationMilestoneRecord = {
	milestone: ActivationMilestone
	reachedAt: string
	packageId: string | null
}

const activationExcludedSurfaces = new Set<RunSurface>(['webhook', 'app_fetch'])

/**
 * Surfaces that count toward package activation. Omitting `surface` keeps the
 * prior "any package-scoped success" behavior for callers that have not wired
 * the field yet.
 */
export function countsTowardPackageActivation(
	surface: RunSurface | string | null | undefined,
): boolean {
	if (surface == null) return true
	return !activationExcludedSurfaces.has(surface as RunSurface)
}
