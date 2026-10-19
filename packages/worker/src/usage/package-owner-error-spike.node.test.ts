import { expect, test } from 'vitest'
import {
	evaluatePackageOwnerSpikeTransition,
	foldPackageOwnerSpikeWindows,
	isPackageOwnerErrorSpikeHealthy,
	isPackageOwnerErrorSpikeTrigger,
	packageOwnerErrorSpikeHealthyMaxErrors,
	packageOwnerErrorSpikeHealthyRate,
	packageOwnerErrorSpikeMinErrors,
	packageOwnerErrorSpikeMinRate,
	parsePackageOwnerSpikeState,
	type PackageOwnerSpikeWindow,
} from './package-owner-error-spike.ts'

function window(input: {
	errors: number
	events: number
}): PackageOwnerSpikeWindow {
	return {
		ownerId: 'owner-1',
		windowStart: '2026-10-19T18:00:00.000Z',
		windowEnd: '2026-10-19T19:00:00.000Z',
		packages: [],
		byMetric: [],
		errors: input.errors,
		events: input.events,
		rate: input.events === 0 ? null : input.errors / input.events,
	}
}

test('package owner spike thresholds use documented constants', () => {
	expect(packageOwnerErrorSpikeMinErrors).toBe(20)
	expect(packageOwnerErrorSpikeMinRate).toBe(0.25)
	expect(packageOwnerErrorSpikeHealthyRate).toBe(0.05)
	expect(packageOwnerErrorSpikeHealthyMaxErrors).toBe(5)

	expect(isPackageOwnerErrorSpikeTrigger({ errors: 19, events: 19 })).toBe(
		false,
	)
	expect(isPackageOwnerErrorSpikeTrigger({ errors: 20, events: 100 })).toBe(
		false,
	)
	expect(isPackageOwnerErrorSpikeTrigger({ errors: 25, events: 100 })).toBe(
		true,
	)

	expect(isPackageOwnerErrorSpikeHealthy({ errors: 4, events: 100 })).toBe(true)
	expect(isPackageOwnerErrorSpikeHealthy({ errors: 6, events: 100 })).toBe(
		false,
	)
	expect(isPackageOwnerErrorSpikeHealthy({ errors: 4, events: 200 })).toBe(true)
	expect(isPackageOwnerErrorSpikeHealthy({ errors: 10, events: 250 })).toBe(
		true,
	)
})

test('ok→alerted emails once; stay alerted without repeats; re-arm then re-alert', () => {
	const now = new Date('2026-10-19T19:05:00.000Z')
	const spike = window({ errors: 40, events: 80 })

	const first = evaluatePackageOwnerSpikeTransition({
		previous: null,
		window: spike,
		now,
	})
	expect(first.action).toBe('alert')
	expect(first.next.status).toBe('alerted')
	expect(first.next.spike?.errors).toBe(40)

	const stillHot = evaluatePackageOwnerSpikeTransition({
		previous: first.next,
		window: window({ errors: 30, events: 60 }),
		now: new Date('2026-10-19T20:05:00.000Z'),
	})
	expect(stillHot.action).toBe('none')
	expect(stillHot.next.status).toBe('alerted')
	expect(stillHot.next.consecutiveHealthyWindows).toBe(0)

	const healthy1 = evaluatePackageOwnerSpikeTransition({
		previous: stillHot.next,
		window: window({ errors: 2, events: 100 }),
		now: new Date('2026-10-19T21:05:00.000Z'),
	})
	expect(healthy1.action).toBe('none')
	expect(healthy1.next.status).toBe('alerted')
	expect(healthy1.next.consecutiveHealthyWindows).toBe(1)

	const healthy2 = evaluatePackageOwnerSpikeTransition({
		previous: healthy1.next,
		window: window({ errors: 1, events: 80 }),
		now: new Date('2026-10-19T22:05:00.000Z'),
	})
	expect(healthy2.action).toBe('rearm')
	expect(healthy2.next.status).toBe('ok')
	expect(healthy2.next.spike).toBeNull()
	expect(healthy2.next.alertedAt).toBeNull()
	expect(healthy2.next.lastActivityAt).toBe('2026-10-19T19:00:00.000Z')

	const again = evaluatePackageOwnerSpikeTransition({
		previous: healthy2.next,
		window: spike,
		now: new Date('2026-10-19T23:05:00.000Z'),
	})
	expect(again.action).toBe('alert')
	expect(again.next.status).toBe('alerted')
})

test('inactivity for 24h re-arms an alerted owner with no current window', () => {
	const spikeWindow: PackageOwnerSpikeWindow = {
		...window({ errors: 40, events: 80 }),
		windowStart: '2026-10-18T18:00:00.000Z',
		windowEnd: '2026-10-18T19:00:00.000Z',
	}
	const alerted = evaluatePackageOwnerSpikeTransition({
		previous: null,
		window: spikeWindow,
		now: new Date('2026-10-18T19:05:00.000Z'),
	}).next
	expect(alerted.status).toBe('alerted')
	expect(alerted.lastActivityAt).toBe('2026-10-18T19:00:00.000Z')

	const tooSoon = evaluatePackageOwnerSpikeTransition({
		previous: alerted,
		window: null,
		now: new Date('2026-10-19T10:00:00.000Z'),
	})
	expect(tooSoon.action).toBe('none')
	expect(tooSoon.next.status).toBe('alerted')

	const afterDay = evaluatePackageOwnerSpikeTransition({
		previous: alerted,
		window: null,
		now: new Date('2026-10-19T20:00:00.000Z'),
	})
	expect(afterDay.action).toBe('rearm')
	expect(afterDay.next.status).toBe('ok')
})

test('fold attributes package metrics to publishers and job metrics to billing owners', () => {
	const windows = foldPackageOwnerSpikeWindows({
		windowStart: new Date('2026-10-19T18:00:00.000Z'),
		windowEnd: new Date('2026-10-19T19:00:00.000Z'),
		packageRows: [
			{
				package_id: 'pkg-a',
				metric: 'package_static_call',
				event_count: 100,
				error_count: 40,
			},
			{
				package_id: 'pkg-a',
				metric: 'package_export',
				event_count: 20,
				error_count: 10,
			},
			{
				package_id: 'pkg-b',
				metric: 'package_static_call',
				event_count: 10,
				error_count: 1,
			},
		],
		accountRows: [
			{
				owner_id: 'owner-eluce',
				metric: 'job_run',
				event_count: 50,
				error_count: 45,
			},
		],
		packageOwners: new Map([
			[
				'pkg-a',
				{ ownerId: 'owner-eluce', kodyId: 'sermon-preparation-preview' },
			],
			['pkg-b', { ownerId: 'owner-other', kodyId: 'other-pkg' }],
		]),
	})

	expect(windows).toHaveLength(2)
	expect(windows[0]).toMatchObject({
		ownerId: 'owner-eluce',
		errors: 95,
		events: 170,
	})
	expect(windows[0]?.packages[0]).toMatchObject({
		kody_id: 'sermon-preparation-preview',
		errors: 50,
	})
	expect(windows[1]).toMatchObject({
		ownerId: 'owner-other',
		errors: 1,
		events: 10,
	})
})

test('parsePackageOwnerSpikeState rejects unknown versions', () => {
	expect(parsePackageOwnerSpikeState({ version: 2, status: 'ok' })).toBeNull()
	expect(
		parsePackageOwnerSpikeState({
			version: 1,
			status: 'alerted',
			alertedAt: '2026-10-19T19:00:00.000Z',
			consecutiveHealthyWindows: 1,
			lastActivityAt: '2026-10-19T19:00:00.000Z',
			lastWindowEnd: '2026-10-19T19:00:00.000Z',
			spike: null,
		}),
	).toMatchObject({ status: 'alerted', consecutiveHealthyWindows: 1 })
})
