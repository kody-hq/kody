/**
 * Dedicated exposure writes for flags with
 * `exposureRecording: 'repo-push-owners'` (currently `repo-push-queue`).
 *
 * The flag is evaluated per repo, so the experiment frame is repo owners who
 * push: each receive-pack records the repo owner's id (`entity_sources.user_id`,
 * a person's stable id or an org id) with the same evaluation that routed the
 * push. That id is also the `git_push` usage event's billing id, so the readout
 * joins exposures and pushes on the same key. Owners whose repos landed on both
 * values in the window count as mixed; per-repo allowlist rows are `override`.
 */

import {
	getFeatureFlagExposureRecording,
	repoPushQueueFlagKey,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import {
	recordFeatureFlagExposures,
	type FeatureFlagExposureEnv,
} from './exposure.ts'
import { type FeatureFlagEvaluation } from './service.ts'

export type RepoPushOwnersExposureInput = {
	env: FeatureFlagExposureEnv
	ownerId: string | null | undefined
	/** Same evaluation that routed the push. */
	evaluation: FeatureFlagEvaluation
	/** Override for tests; defaults to the repo push queue flag. */
	flagKey?: FeatureFlagKey
}

/** Record one repo-owner exposure. Never throws: pushes must not fail on attribution. */
export async function recordRepoPushOwnersFlagExposure(
	input: RepoPushOwnersExposureInput,
): Promise<void> {
	try {
		const ownerId = input.ownerId?.trim() ?? ''
		if (!ownerId) return
		const flagKey = input.flagKey ?? repoPushQueueFlagKey
		if (getFeatureFlagExposureRecording(flagKey) !== 'repo-push-owners') {
			return
		}
		await recordFeatureFlagExposures(input.env, {
			stableUserId: ownerId,
			evaluations: { [flagKey]: input.evaluation },
			recordingSite: 'dedicated',
		})
	} catch (error) {
		console.warn('repo-push-owners-exposure-failed', error)
	}
}
