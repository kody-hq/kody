import { expect, test } from 'vitest'
import {
	attachPublishPhaseTimings,
	mergePublishPhaseTimings,
	recordPublishPhaseTiming,
	timePublishExternalPushPhase,
	withPublishAttemptTotalMs,
	type PublishPhaseTimings,
} from './publish-phase-timing.ts'

test('timePublishExternalPushPhase records stable capability field names', async () => {
	const timings: PublishPhaseTimings = {}
	await timePublishExternalPushPhase(
		{ phase: 'checks/typecheck', timings },
		async () => 'ok',
	)
	expect(timings).toEqual({
		checks_typecheck_ms: expect.any(Number),
	})
	expect(timings.checks_typecheck_ms).toBeGreaterThanOrEqual(0)

	recordPublishPhaseTiming(timings, 'checks/bundle', 12)
	recordPublishPhaseTiming(timings, 'rebuild', 34)
	expect(timings).toEqual({
		checks_typecheck_ms: expect.any(Number),
		checks_bundle_ms: 12,
		rebuild_ms: 34,
	})
})

test('merge and attach keep check-bundle and rebuild separate', () => {
	const merged = withPublishAttemptTotalMs(
		mergePublishPhaseTimings(
			{ clone_ms: 5, checks_bundle_ms: 40 },
			{ rebuild_ms: 90, dependents_ms: 3 },
		),
		100,
		250,
	)
	expect(merged).toEqual({
		clone_ms: 5,
		checks_bundle_ms: 40,
		rebuild_ms: 90,
		dependents_ms: 3,
		total_ms: 150,
	})

	expect(
		attachPublishPhaseTimings(
			{ status: 'already_published', published_commit: 'commit-1' },
			{ clone_ms: 8 },
		),
	).toEqual({
		status: 'already_published',
		published_commit: 'commit-1',
		phase_timings: { clone_ms: 8 },
	})
	expect(
		attachPublishPhaseTimings(
			{ status: 'checks_failed', run_id: 'run-1' },
			{ clone_ms: 8 },
		),
	).toEqual({
		status: 'checks_failed',
		run_id: 'run-1',
	})
})
