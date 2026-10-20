import { expect, test } from 'vitest'
import {
	appendFleetUsersAffectedHistory,
	baselineFromHistory,
	buildFleetUsersAffectedPackageActorQuery,
	clearFleetUsersAffectedPendingNotify,
	evaluateFleetUsersAffectedTransition,
	fleetUsersAffectedBaselineFactor,
	fleetUsersAffectedMinAffected,
	fleetUsersAffectedMinFractionDelta,
	foldFleetUsersAffectedWindow,
	isFleetUsersAffectedElevated,
	medianOf,
	type FleetUsersAffectedWindowMetrics,
} from './fleet-users-affected.ts'

function metrics(input: {
	affectedUsers: number
	activeUsers: number
	windowEnd?: string
}): FleetUsersAffectedWindowMetrics {
	return {
		windowStart: '2026-10-19T18:00:00.000Z',
		windowEnd: input.windowEnd ?? '2026-10-19T18:15:00.000Z',
		affectedUsers: input.affectedUsers,
		activeUsers: input.activeUsers,
		fraction:
			input.activeUsers <= 0 ? null : input.affectedUsers / input.activeUsers,
		packages: [],
		byMetric: [],
		dominantPackage: null,
	}
}

test('users-affected thresholds require volume floor and fraction lift', () => {
	expect(fleetUsersAffectedMinAffected).toBe(5)
	expect(fleetUsersAffectedBaselineFactor).toBe(2)
	expect(fleetUsersAffectedMinFractionDelta).toBe(0.05)

	expect(
		isFleetUsersAffectedElevated({
			affectedUsers: 4,
			activeUsers: 100,
			baselineAffectedMedian: 1,
			baselineFractionMedian: 0.01,
		}),
	).toBe(false)

	expect(
		isFleetUsersAffectedElevated({
			affectedUsers: 10,
			activeUsers: 100,
			baselineAffectedMedian: 3,
			baselineFractionMedian: 0.02,
		}),
	).toBe(true)

	// Single-owner noise: one affected user cannot clear max(5, 2x baseline).
	expect(
		isFleetUsersAffectedElevated({
			affectedUsers: 1,
			activeUsers: 1,
			baselineAffectedMedian: 0,
			baselineFractionMedian: 0,
		}),
	).toBe(false)
})

test('medianOf and history baseline', () => {
	expect(medianOf([])).toBeNull()
	expect(medianOf([1, 3, 2])).toBe(2)
	expect(medianOf([1, 2, 3, 4])).toBe(2.5)

	const history = appendFleetUsersAffectedHistory({
		history: { version: 1, samples: [] },
		windowEnd: 'a',
		affectedUsers: 2,
		activeUsers: 100,
		fraction: 0.02,
	})
	const withSecond = appendFleetUsersAffectedHistory({
		history,
		windowEnd: 'b',
		affectedUsers: 4,
		activeUsers: 100,
		fraction: 0.04,
	})
	expect(baselineFromHistory(withSecond)).toEqual({
		baselineAffectedMedian: 3,
		baselineFractionMedian: 0.03,
	})

	const withSpike = appendFleetUsersAffectedHistory({
		history: withSecond,
		windowEnd: 'c',
		affectedUsers: 20,
		activeUsers: 100,
		fraction: 0.2,
	})
	// Debounce pair: exclude the first elevated sample so 2×baseline stays
	// below the still-hot second window.
	expect(baselineFromHistory(withSpike, { excludeTrailing: 1 })).toEqual({
		baselineAffectedMedian: 3,
		baselineFractionMedian: 0.03,
	})
})

test('debounce elevate once, no repeats while firing, resolve then re-arm', () => {
	const now = new Date('2026-10-19T18:20:00.000Z')
	const hot = metrics({ affectedUsers: 12, activeUsers: 100 })
	const calm = metrics({
		affectedUsers: 1,
		activeUsers: 100,
		windowEnd: '2026-10-19T18:30:00.000Z',
	})

	const first = evaluateFleetUsersAffectedTransition({
		previous: null,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now,
	})
	expect(first.action).toBe('none')
	expect(first.next.status).toBe('ok')
	expect(first.next.consecutiveElevatedWindows).toBe(1)

	const second = evaluateFleetUsersAffectedTransition({
		previous: first.next,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T18:35:00.000Z'),
	})
	expect(second.action).toBe('elevate')
	expect(second.next.status).toBe('firing')
	expect(second.next.pendingNotify).toBe('elevate')
	const afterNotify = clearFleetUsersAffectedPendingNotify(second.next)

	const stillHot = evaluateFleetUsersAffectedTransition({
		previous: afterNotify,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T18:50:00.000Z'),
	})
	expect(stillHot.action).toBe('none')
	expect(stillHot.next.status).toBe('firing')

	const clear1 = evaluateFleetUsersAffectedTransition({
		previous: stillHot.next,
		metrics: calm,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T19:05:00.000Z'),
	})
	expect(clear1.action).toBe('none')
	expect(clear1.next.status).toBe('firing')
	expect(clear1.next.consecutiveClearWindows).toBe(1)

	const clear2 = evaluateFleetUsersAffectedTransition({
		previous: clear1.next,
		metrics: calm,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T19:20:00.000Z'),
	})
	expect(clear2.action).toBe('resolve')
	expect(clear2.next.status).toBe('ok')
	expect(clear2.next.pendingNotify).toBe('resolve')
	expect(clear2.next.incidentStartedAt).toBe(second.next.incidentStartedAt)
	expect(clear2.next).toMatchObject({
		lastWindowEnd: calm.windowEnd,
		lastMetrics: calm,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		consecutiveElevatedWindows: 0,
		consecutiveClearWindows: 0,
	})

	const rearmElevate = evaluateFleetUsersAffectedTransition({
		previous: { ...clear2.next, pendingNotify: null, incidentStartedAt: null },
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T19:35:00.000Z'),
	})
	expect(rearmElevate.action).toBe('none')
	const rearmElevate2 = evaluateFleetUsersAffectedTransition({
		previous: rearmElevate.next,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T19:50:00.000Z'),
	})
	expect(rearmElevate2.action).toBe('elevate')
})

test('fold ranks packages by affected users and labels >50% dominant', () => {
	const folded = foldFleetUsersAffectedWindow({
		windowStart: new Date('2026-10-19T18:00:00.000Z'),
		windowEnd: new Date('2026-10-19T18:15:00.000Z'),
		affectedActorCount: 10,
		activeActorCount: 50,
		packageActorRows: [
			{ package_id: 'pkg-a', metric: 'package_export', actor_id: 'u1' },
			{ package_id: 'pkg-a', metric: 'package_export', actor_id: 'u2' },
			{ package_id: 'pkg-a', metric: 'package_export', actor_id: 'u3' },
			{ package_id: 'pkg-a', metric: 'package_export', actor_id: 'u4' },
			{ package_id: 'pkg-a', metric: 'package_export', actor_id: 'u5' },
			{ package_id: 'pkg-a', metric: 'package_export', actor_id: 'u6' },
			{ package_id: 'pkg-b', metric: 'job_run', actor_id: 'u7' },
			{ package_id: 'pkg-b', metric: 'job_run', actor_id: 'u8' },
		],
		packageKodyIds: new Map([
			['pkg-a', 'popular-broken'],
			['pkg-b', 'other'],
		]),
	})
	expect(folded.packages[0]).toMatchObject({
		kody_id: 'popular-broken',
		affected_users: 6,
		share: 0.6,
	})
	expect(folded.dominantPackage).toMatchObject({
		kody_id: 'popular-broken',
		share: 0.6,
	})
	expect(
		folded.byMetric.find((row) => row.metric === 'package_export'),
	).toEqual({
		metric: 'package_export',
		affected_users: 6,
	})
})

test('fold keeps byMetric when package name lookup is empty', () => {
	const folded = foldFleetUsersAffectedWindow({
		windowStart: new Date('2026-10-19T18:00:00.000Z'),
		windowEnd: new Date('2026-10-19T18:15:00.000Z'),
		affectedActorCount: 2,
		activeActorCount: 10,
		packageActorRows: [
			{ package_id: 'pkg-a', metric: 'job_run', actor_id: 'u1' },
			{ package_id: 'pkg-a', metric: 'job_run', actor_id: 'u2' },
		],
		packageKodyIds: new Map(),
	})
	expect(folded.packages).toEqual([])
	expect(folded.byMetric).toEqual([{ metric: 'job_run', affected_users: 2 }])
})

test('buildFleetUsersAffectedPackageActorQuery aggregates distinct tuples', () => {
	const query = buildFleetUsersAffectedPackageActorQuery({
		dataset: 'USAGE_EVENTS',
		windowStart: new Date('2026-10-19T18:00:00.000Z'),
		windowEnd: new Date('2026-10-19T18:15:00.000Z'),
	})
	expect(query).toContain('GROUP BY package_id, metric, actor_id')
})

test('pending elevate replays on the next window until cleared', () => {
	const now = new Date('2026-10-19T18:20:00.000Z')
	const hot = metrics({ affectedUsers: 12, activeUsers: 100 })
	const first = evaluateFleetUsersAffectedTransition({
		previous: null,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now,
	})
	const elevated = evaluateFleetUsersAffectedTransition({
		previous: first.next,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T18:35:00.000Z'),
	})
	expect(elevated.action).toBe('elevate')
	expect(elevated.next.pendingNotify).toBe('elevate')

	const nextWindow = evaluateFleetUsersAffectedTransition({
		previous: elevated.next,
		metrics: metrics({
			affectedUsers: 12,
			activeUsers: 100,
			windowEnd: '2026-10-19T18:45:00.000Z',
		}),
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T18:50:00.000Z'),
	})
	expect(nextWindow.action).toBe('elevate')
	expect(nextWindow.next.pendingNotify).toBe('elevate')
	expect(nextWindow.next.status).toBe('firing')
})

test('pending resolve is not replaced by a later elevate', () => {
	const incidentStartedAt = '2026-10-19T18:35:00.000Z'
	const pendingResolve = {
		version: 1 as const,
		status: 'ok' as const,
		consecutiveElevatedWindows: 0,
		consecutiveClearWindows: 0,
		incidentStartedAt,
		lastWindowEnd: '2026-10-19T19:00:00.000Z',
		lastMetrics: metrics({
			affectedUsers: 1,
			activeUsers: 100,
			windowEnd: '2026-10-19T19:00:00.000Z',
		}),
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		pendingNotify: 'resolve' as const,
	}
	const hot = metrics({
		affectedUsers: 12,
		activeUsers: 100,
		windowEnd: '2026-10-19T19:15:00.000Z',
	})
	const firstHot = evaluateFleetUsersAffectedTransition({
		previous: pendingResolve,
		metrics: hot,
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T19:20:00.000Z'),
	})
	expect(firstHot.action).toBe('resolve')
	expect(firstHot.next.pendingNotify).toBe('resolve')
	expect(firstHot.next.incidentStartedAt).toBe(incidentStartedAt)
	expect(firstHot.resolvedIncidentStartedAt).toBe(incidentStartedAt)

	const secondHot = evaluateFleetUsersAffectedTransition({
		previous: firstHot.next,
		metrics: metrics({
			affectedUsers: 12,
			activeUsers: 100,
			windowEnd: '2026-10-19T19:30:00.000Z',
		}),
		baselineAffectedMedian: 2,
		baselineFractionMedian: 0.02,
		now: new Date('2026-10-19T19:35:00.000Z'),
	})
	expect(secondHot.action).toBe('resolve')
	expect(secondHot.next.pendingNotify).toBe('resolve')
	expect(secondHot.next.incidentStartedAt).toBe(incidentStartedAt)
})
