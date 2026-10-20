import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	type PackageOwnerSpikeState,
	type PackageOwnerSpikeWindow,
} from './package-owner-error-spike.ts'

const queryAnalyticsEngineSql = vi.fn()

vi.mock('./aggregate-rollups.ts', async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryAnalyticsEngineSql(...args),
	}
})

const {
	evaluatePackageOwnerSpikeTransition,
	foldPackageOwnerSpikeWindows,
	isPackageOwnerErrorSpikeHealthy,
	isPackageOwnerErrorSpikeTrigger,
	isPendingSpikeExpired,
	packageOwnerErrorSpikeAlertedIndexKvKey,
	packageOwnerErrorSpikeKvKey,
	packageOwnerErrorSpikeMaxDeliveryAttempts,
	parsePackageOwnerSpikeState,
	refreshPackageOwnerErrorSpikes,
} = await import('./package-owner-error-spike.ts')

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

function alertedFromPending(
	pending: PackageOwnerSpikeState,
	alertedAt: string,
): PackageOwnerSpikeState {
	return {
		...pending,
		status: 'alerted',
		alertedAt,
		pendingSince: null,
		deliveryAttempts: 0,
	}
}

function createMemoryKv() {
	const store = new Map<string, string>()
	const puts: Array<string> = []
	const kv = {
		async get<T>(key: string, type?: 'json' | 'text') {
			const raw = store.get(key)
			if (raw == null) return null
			return type === 'json' ? (JSON.parse(raw) as T) : raw
		},
		async put(key: string, value: string) {
			puts.push(key)
			store.set(key, value)
		},
		store,
		puts,
	}
	return kv as unknown as KVNamespace & {
		store: Map<string, string>
		puts: Array<string>
	}
}

test('package owner spike thresholds require volume floor and rate lift', () => {
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

test('ok→pending on trigger; alerted stays quiet; re-arm then re-alert', () => {
	const now = new Date('2026-10-19T19:05:00.000Z')
	const spike = window({ errors: 40, events: 80 })

	const first = evaluatePackageOwnerSpikeTransition({
		previous: null,
		window: spike,
		now,
	})
	expect(first.action).toBe('alert')
	expect(first.next.status).toBe('pending')
	expect(first.next.spike?.errors).toBe(40)
	expect(first.next.spike?.windowStart).toBe(spike.windowStart)
	expect(first.next.pendingSince).toBe(now.toISOString())

	const delivered = alertedFromPending(first.next, now.toISOString())

	const stillHot = evaluatePackageOwnerSpikeTransition({
		previous: delivered,
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
	expect(again.next.status).toBe('pending')
})

test('pending retries independent of a quieter next window; abandons when aged out', () => {
	const spike = window({ errors: 40, events: 80 })
	const pending = evaluatePackageOwnerSpikeTransition({
		previous: null,
		window: spike,
		now: new Date('2026-10-19T19:05:00.000Z'),
	}).next
	expect(pending.status).toBe('pending')

	const quietRetry = evaluatePackageOwnerSpikeTransition({
		previous: pending,
		window: window({ errors: 1, events: 100 }),
		now: new Date('2026-10-19T20:05:00.000Z'),
	})
	expect(quietRetry.action).toBe('retry_alert')
	expect(quietRetry.next.status).toBe('pending')
	expect(quietRetry.next.spike?.errors).toBe(40)

	const expired = evaluatePackageOwnerSpikeTransition({
		previous: {
			...pending,
			pendingSince: '2026-10-18T18:00:00.000Z',
		},
		window: window({ errors: 1, events: 100 }),
		now: new Date('2026-10-19T20:05:00.000Z'),
	})
	expect(expired.action).toBe('abandon')
	expect(expired.next.status).toBe('ok')
	expect(expired.next.spike).toBeNull()

	expect(
		isPendingSpikeExpired({
			state: {
				...pending,
				deliveryAttempts: packageOwnerErrorSpikeMaxDeliveryAttempts,
			},
			now: new Date('2026-10-19T20:05:00.000Z'),
		}),
	).toBe(true)
})

test('inactivity for 24h re-arms an alerted owner with no current window', () => {
	const spikeWindow: PackageOwnerSpikeWindow = {
		...window({ errors: 40, events: 80 }),
		windowStart: '2026-10-18T18:00:00.000Z',
		windowEnd: '2026-10-18T19:00:00.000Z',
	}
	const pending = evaluatePackageOwnerSpikeTransition({
		previous: null,
		window: spikeWindow,
		now: new Date('2026-10-18T19:05:00.000Z'),
	}).next
	const alerted = alertedFromPending(pending, '2026-10-18T19:05:00.000Z')
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
	expect(
		parsePackageOwnerSpikeState({
			version: 1,
			status: 'pending',
			pendingSince: '2026-10-19T19:00:00.000Z',
			deliveryAttempts: 1,
			consecutiveHealthyWindows: 0,
			lastActivityAt: '2026-10-19T19:00:00.000Z',
			lastWindowEnd: '2026-10-19T19:00:00.000Z',
			spike: {
				startedAt: '2026-10-19T19:00:00.000Z',
				windowStart: '2026-10-19T18:00:00.000Z',
				windowEnd: '2026-10-19T19:00:00.000Z',
				errors: 40,
				events: 80,
				rate: 0.5,
				packages: [],
				byMetric: [],
			},
		}),
	).toMatchObject({ status: 'pending', deliveryAttempts: 1 })
	expect(
		parsePackageOwnerSpikeState({
			version: 1,
			status: 'pending',
			pendingSince: '2026-10-19T19:00:00.000Z',
			deliveryAttempts: 1,
			spike: null,
		}),
	).toBeNull()
})

test('refresh persists pending on notify failure and retries after a quiet hour', async () => {
	consoleWarn.mockImplementation(() => {})
	const kv = createMemoryKv()
	const ownerId = 'owner-retry'
	const alerts: Array<{ ownerId: string; errors: number }> = []
	let failNext = true

	const envBase = {
		BUNDLE_ARTIFACTS_KV: kv,
		APP_DB: {
			prepare() {
				return {
					bind() {
						return this
					},
					async all() {
						return { results: [] }
					},
				}
			},
		} as unknown as D1Database,
		USAGE_EVENTS: {} as AnalyticsEngineDataset,
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
	}

	// Seed a pending episode as if the prior sweep retained a failed notify.
	const pendingState: PackageOwnerSpikeState = {
		version: 1,
		status: 'pending',
		alertedAt: null,
		pendingSince: '2026-10-19T19:05:00.000Z',
		deliveryAttempts: 1,
		consecutiveHealthyWindows: 0,
		lastActivityAt: '2026-10-19T19:00:00.000Z',
		lastWindowEnd: '2026-10-19T19:00:00.000Z',
		spike: {
			startedAt: '2026-10-19T19:05:00.000Z',
			windowStart: '2026-10-19T18:00:00.000Z',
			windowEnd: '2026-10-19T19:00:00.000Z',
			errors: 40,
			events: 80,
			rate: 0.5,
			packages: [],
			byMetric: [],
		},
	}
	await kv.put(
		packageOwnerErrorSpikeKvKey(ownerId),
		JSON.stringify(pendingState),
	)
	await kv.put(
		packageOwnerErrorSpikeAlertedIndexKvKey,
		JSON.stringify([ownerId]),
	)

	// Quiet hour: AE returns nothing for this owner, but pending is indexed.
	queryAnalyticsEngineSql.mockResolvedValue([])

	const first = await refreshPackageOwnerErrorSpikes({
		env: envBase,
		now: new Date('2026-10-19T20:05:00.000Z'),
		onAlert: async ({ ownerId: id, window: w }) => {
			alerts.push({ ownerId: id, errors: w.errors })
			if (failNext) {
				failNext = false
				throw new Error('smtp down')
			}
		},
	})
	expect(first).toMatchObject({ status: 'refreshed', alerted: 0 })
	expect(alerts).toEqual([{ ownerId, errors: 40 }])
	const stillPending = parsePackageOwnerSpikeState(
		JSON.parse(kv.store.get(packageOwnerErrorSpikeKvKey(ownerId)) ?? 'null'),
	)
	expect(stillPending?.status).toBe('pending')
	expect(stillPending?.deliveryAttempts).toBe(2)

	const second = await refreshPackageOwnerErrorSpikes({
		env: envBase,
		now: new Date('2026-10-19T21:05:00.000Z'),
		onAlert: async ({ ownerId: id, window: w }) => {
			alerts.push({ ownerId: id, errors: w.errors })
		},
	})
	expect(second).toMatchObject({ status: 'refreshed', alerted: 1 })
	expect(alerts).toEqual([
		{ ownerId, errors: 40 },
		{ ownerId, errors: 40 },
	])
	const delivered = parsePackageOwnerSpikeState(
		JSON.parse(kv.store.get(packageOwnerErrorSpikeKvKey(ownerId)) ?? 'null'),
	)
	expect(delivered?.status).toBe('alerted')
	expect(delivered?.spike?.errors).toBe(40)
})

test('refresh writes the alerted-owner index once per sweep', async () => {
	const kv = createMemoryKv()
	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes('blob3 AS package_id')) return []
			return [
				{
					owner_id: 'owner-a',
					metric: 'job_run',
					event_count: 100,
					error_count: 40,
				},
				{
					owner_id: 'owner-b',
					metric: 'job_run',
					event_count: 100,
					error_count: 40,
				},
			]
		},
	)

	const result = await refreshPackageOwnerErrorSpikes({
		env: {
			BUNDLE_ARTIFACTS_KV: kv,
			APP_DB: {
				prepare() {
					return {
						bind() {
							return this
						},
						async all() {
							return { results: [] }
						},
					}
				},
			} as unknown as D1Database,
			USAGE_EVENTS: {} as AnalyticsEngineDataset,
			CLOUDFLARE_ACCOUNT_ID: 'acct',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		now: new Date('2026-10-19T19:05:00.000Z'),
		onAlert: async () => {},
	})
	expect(result).toMatchObject({
		status: 'refreshed',
		alerted: 2,
	})
	const indexPuts = kv.puts.filter(
		(key) => key === packageOwnerErrorSpikeAlertedIndexKvKey,
	)
	expect(indexPuts).toHaveLength(1)
	const index = JSON.parse(
		kv.store.get(packageOwnerErrorSpikeAlertedIndexKvKey) ?? '[]',
	) as Array<string>
	expect(index.sort()).toEqual(['owner-a', 'owner-b'])
})
