import { expect, test } from 'vitest'
import { runTiming } from './run-timing.ts'

test('adds Kody-side time and splits out transit from what the daemon reported', () => {
	expect(
		runTiming(
			{
				queueMs: 1,
				setupMs: 40.4,
				packageGraphMs: 30,
				packageGraphCached: false,
				executeMs: 6,
				daemonMs: 48,
			},
			1_000,
			1_120,
		),
	).toEqual({
		queueMs: 1,
		setupMs: 40,
		packageGraphMs: 30,
		packageGraphCached: false,
		executeMs: 6,
		daemonMs: 48,
		serverMs: 120,
		transitMs: 72,
	})
})

test('drops timing it cannot trust instead of reporting nonsense', () => {
	expect(runTiming(undefined, 1_000, 1_100)).toBeUndefined()
	expect(runTiming({ executeMs: 5 }, 1_000, 1_100)).toBeUndefined()
	expect(runTiming({ daemonMs: 5 }, null, 1_100)).toBeUndefined()
	expect(
		runTiming({ daemonMs: 500, executeMs: -3, setupMs: 'x' }, 1_000, 1_100),
	).toEqual({
		queueMs: 0,
		setupMs: 0,
		executeMs: 0,
		daemonMs: 500,
		serverMs: 100,
		transitMs: 0,
	})
})
