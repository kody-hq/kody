import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { type FleetEntitlementCrossingSnapshot } from '#worker/admin/fleet-usage-insights.ts'
import {
	consoleWarn,
	silenceExpectedConsoleWarns,
} from '#worker/test-support/console-spies.ts'
import { type FleetEntitlementCrossedEvent } from '#worker/usage/fleet-entitlement-crossing-subscription-event.ts'
import type * as fleetEntitlementCrossingSubscriptions from '#worker/usage/fleet-entitlement-crossing-subscriptions.ts'

const loadFleetEntitlementCrossingSnapshots =
	vi.fn<
		(input: {
			db: D1Database
			env: Env
			now: Date
		}) => Promise<Array<FleetEntitlementCrossingSnapshot>>
	>()

vi.mock('#worker/admin/fleet-usage-insights.ts', () => ({
	loadFleetEntitlementCrossingSnapshots: (input: {
		db: D1Database
		env: Env
		now: Date
	}) => loadFleetEntitlementCrossingSnapshots(input),
	adminFleetEntitlementSweepUserLimit: 15,
	fleetRuntimeDurationAlertThresholdMs: 24 * 60 * 60 * 1000,
}))

const dispatchFleetEntitlementCrossingSubscriptionEvent = vi.fn<
	typeof fleetEntitlementCrossingSubscriptions.dispatchFleetEntitlementCrossingSubscriptionEvent
>(async () => [])

vi.mock('#worker/usage/fleet-entitlement-crossing-subscriptions.ts', () => ({
	dispatchFleetEntitlementCrossingSubscriptionEvent: (
		...args: Parameters<
			typeof fleetEntitlementCrossingSubscriptions.dispatchFleetEntitlementCrossingSubscriptionEvent
		>
	) => dispatchFleetEntitlementCrossingSubscriptionEvent(...args),
}))

const {
	emitFleetEntitlementCrossingEvents,
	fleetEntitlementCrossingKvKey,
	fleetEntitlementHitKvKey,
	shouldRunUsageEntitlementAlertCron,
} = await import('#app/usage-entitlement-alerts.ts')

type Resource =
	FleetEntitlementCrossingSnapshot['entitlements'][number]['resource']

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function snapshot(input: {
	stableUserId?: string
	username?: string
	plan?: FleetEntitlementCrossingSnapshot['plan']
	isAdmin?: boolean
	resource?: Resource
	current?: number
	limit?: number
	runtimeDurationMs?: number
	uniqueWorkerDays?: number
}): FleetEntitlementCrossingSnapshot {
	const current = input.current ?? 0
	const limit = input.limit ?? 10
	const resource = input.resource ?? 'saved_packages'
	const percentOfLimit = limit === 0 ? null : current / limit
	return {
		stableUserId: input.stableUserId ?? 'user-a',
		username: input.username ?? 'alice',
		plan: input.plan ?? 'free',
		ladder: 'public',
		isAdmin: input.isAdmin ?? false,
		entitlements: [
			{
				resource,
				label: resource.replaceAll('_', ' '),
				current,
				limit,
				percentOfLimit,
				overEightyPercent: percentOfLimit != null && percentOfLimit > 0.8,
			},
		],
		runtimeDurationMs: input.runtimeDurationMs ?? 0,
		uniqueWorkerDays: input.uniqueWorkerDays ?? 0,
	}
}

function setSnapshots(...snapshots: Array<FleetEntitlementCrossingSnapshot>) {
	loadFleetEntitlementCrossingSnapshots.mockResolvedValue(snapshots)
}

function createEnv(kv?: KVNamespace) {
	return {
		APP_DB: {} as D1Database,
		APP_BASE_URL: 'https://heykody.dev/',
		BUNDLE_ARTIFACTS_KV: kv,
	}
}

function emit(env: ReturnType<typeof createEnv>, iso: string) {
	return emitFleetEntitlementCrossingEvents({ env, now: new Date(iso) })
}

function emitted(count: number) {
	return { status: 'emitted', issueCount: count, crossingCount: count }
}

function dispatchedEvent(index: number) {
	const call = dispatchFleetEntitlementCrossingSubscriptionEvent.mock.calls[
		index
	]?.[0] as { event: FleetEntitlementCrossedEvent } | undefined
	return call?.event
}

type Crossing = Parameters<typeof fleetEntitlementCrossingKvKey>[0]['crossing']

function crossingKey(crossing: Crossing) {
	return fleetEntitlementCrossingKvKey({
		userId: ownerIdFromStored('user-a'),
		crossing,
	})
}

function entitlementKey(
	threshold: 'approaching' | 'reached',
	resource: Resource = 'saved_packages',
	day?: string,
) {
	return crossingKey({ kind: 'entitlement', threshold, resource, day })
}

const at = (iso: string) => String(new Date(iso).getTime())

test('fleet entitlement crossings emit once per threshold, then rematch after a drop', async () => {
	expect(
		shouldRunUsageEntitlementAlertCron(new Date('2026-08-24T12:00:00.000Z')),
	).toBe(true)
	expect(
		shouldRunUsageEntitlementAlertCron(new Date('2026-08-24T12:05:00.000Z')),
	).toBe(false)

	loadFleetEntitlementCrossingSnapshots.mockResolvedValueOnce([])
	expect(
		await emitFleetEntitlementCrossingEvents({ env: createEnv(createKv().kv) }),
	).toEqual({ status: 'no_pressure' })
	expect(
		dispatchFleetEntitlementCrossingSubscriptionEvent,
	).not.toHaveBeenCalled()
	expect(
		await emitFleetEntitlementCrossingEvents({ env: createEnv() }),
	).toEqual({ status: 'skipped', reason: 'no_kv' })

	silenceExpectedConsoleWarns(['fleet-entitlement-crossing-emitted'])
	const { kv, store } = createKv()
	const env = createEnv(kv)
	const first = '2026-08-24T12:00:00.000Z'
	setSnapshots(snapshot({ current: 9, limit: 10 }))
	expect(await emit(env, first)).toEqual(emitted(1))
	expect(
		dispatchFleetEntitlementCrossingSubscriptionEvent,
	).toHaveBeenCalledTimes(1)
	expect(dispatchedEvent(0)).toMatchObject({
		event: 'fleet.entitlement.crossed',
		kind: 'entitlement',
		user: { id: 'user-a', username: 'alice' },
		resource: 'saved_packages',
		threshold: 'approaching',
		current: 9,
		limit: 10,
		percent_of_limit: 0.9,
		insights_url: 'https://heykody.dev/admin/insights',
		users_url: 'https://heykody.dev/admin/users',
	})
	expect(store.get(entitlementKey('approaching'))).toBe(at(first))

	expect(await emit(env, '2026-08-24T13:00:00.000Z')).toEqual({
		status: 'no_new_crossings',
		issueCount: 1,
	})
	expect(
		dispatchFleetEntitlementCrossingSubscriptionEvent,
	).toHaveBeenCalledTimes(1)

	setSnapshots(snapshot({ current: 10, limit: 10 }))
	expect(await emit(env, '2026-08-24T14:00:00.000Z')).toEqual(emitted(1))
	expect(dispatchedEvent(1)).toMatchObject({
		kind: 'entitlement',
		threshold: 'reached',
		current: 10,
		limit: 10,
		percent_of_limit: 1,
	})

	setSnapshots(snapshot({ current: 2, limit: 10 }))
	expect(await emit(env, '2026-08-24T15:00:00.000Z')).toEqual({
		status: 'no_pressure',
	})
	expect(store.get(entitlementKey('approaching'))).toBeUndefined()

	setSnapshots(snapshot({ current: 9, limit: 10 }))
	expect(await emit(env, '2026-08-24T16:00:00.000Z')).toEqual(emitted(1))
	expect(
		dispatchFleetEntitlementCrossingSubscriptionEvent,
	).toHaveBeenCalledTimes(3)
	expect(consoleWarn).toHaveBeenCalledTimes(3)
})

test('runtime duration crossings emit once per UTC month and daily resources key by day', async () => {
	silenceExpectedConsoleWarns([
		'fleet-entitlement-crossing-emitted',
		'fleet-entitlement-crossing-dispatch-failed',
	])
	const { kv, store } = createKv()
	const now = '2026-08-24T12:00:00.000Z'
	setSnapshots(
		snapshot({
			resource: 'execute_unique_workers_per_day',
			current: 250,
			limit: 250,
			runtimeDurationMs: 90_000_000,
		}),
	)
	expect(await emit(createEnv(kv), now)).toEqual(emitted(2))
	expect(
		store.get(
			entitlementKey(
				'reached',
				'execute_unique_workers_per_day',
				utcDayKey(new Date(now)),
			),
		),
	).toBe(at(now))
	expect(
		store.get(crossingKey({ kind: 'runtime_duration', month: '2026-08' })),
	).toBe(at(now))
	expect(await emit(createEnv(kv), '2026-08-24T18:00:00.000Z')).toEqual({
		status: 'no_new_crossings',
		issueCount: 2,
	})

	// A failed fan-out does not count as a new crossing.
	dispatchFleetEntitlementCrossingSubscriptionEvent.mockRejectedValueOnce(
		new Error('fan-out failed'),
	)
	setSnapshots(
		snapshot({
			stableUserId: ownerIdFromStored('user-b'),
			username: 'bob',
			current: 10,
		}),
	)
	expect(
		await emit(createEnv(createKv().kv), '2026-08-24T19:00:00.000Z'),
	).toEqual({ status: 'no_new_crossings', issueCount: 1 })
})

test('repeated execute-cap days and unique-worker cost emit once, then rematch after a drop', async () => {
	silenceExpectedConsoleWarns(['fleet-entitlement-crossing-emitted'])
	const { kv, store } = createKv()
	const env = createEnv(kv)
	const executeSnapshot = (current: number, uniqueWorkerDays: number) =>
		snapshot({
			resource: 'execute_unique_workers_per_day',
			current,
			limit: 100,
			uniqueWorkerDays,
			plan: 'free',
		})

	const day1 = '2026-08-24T12:00:00.000Z'
	setSnapshots(executeSnapshot(100, 0))
	expect(await emit(env, day1)).toEqual(emitted(1))
	expect(
		store.get(
			fleetEntitlementHitKvKey({
				userId: ownerIdFromStored('user-a'),
				resource: 'execute_unique_workers_per_day',
				day: utcDayKey(new Date(day1)),
			}),
		),
	).toBe(at(day1))
	expect(await emit(env, '2026-08-25T12:00:00.000Z')).toEqual(emitted(1))

	const day3 = '2026-08-26T12:00:00.000Z'
	setSnapshots(executeSnapshot(100, 1000))
	expect(await emit(env, day3)).toEqual(emitted(3))
	expect(
		dispatchFleetEntitlementCrossingSubscriptionEvent.mock.calls.map(
			(_, index) => dispatchedEvent(index)?.kind,
		),
	).toEqual([
		'entitlement',
		'entitlement',
		'entitlement',
		'repeated_entitlement',
		'dynamic_worker_cost',
	])
	expect(dispatchedEvent(3)).toMatchObject({
		kind: 'repeated_entitlement',
		resource: 'execute_unique_workers_per_day',
		days_at_limit: 3,
		window_days: 7,
		threshold_days: 3,
	})
	expect(dispatchedEvent(4)).toMatchObject({
		kind: 'dynamic_worker_cost',
		unique_worker_days: 1000,
		estimated_gross_usd: 2,
		threshold_usd: 2,
	})
	const repeatedKey = crossingKey({
		kind: 'repeated_entitlement',
		resource: 'execute_unique_workers_per_day',
	})
	expect(store.get(repeatedKey)).toBe(at(day3))

	expect(await emit(env, '2026-08-26T18:00:00.000Z')).toEqual({
		status: 'no_new_crossings',
		issueCount: 3,
	})

	setSnapshots(executeSnapshot(10, 100))
	expect(await emit(env, '2026-09-03T12:00:00.000Z')).toEqual({
		status: 'no_pressure',
	})
	expect(store.get(repeatedKey)).toBeUndefined()
})

test('admin accounts do not page repeated-execute or unique-worker cost trains', async () => {
	silenceExpectedConsoleWarns(['fleet-entitlement-crossing-emitted'])
	setSnapshots(
		snapshot({
			isAdmin: true,
			plan: 'max',
			resource: 'execute_unique_workers_per_day',
			current: 100,
			limit: 100,
			uniqueWorkerDays: 50_000,
		}),
	)
	expect(
		await emit(createEnv(createKv().kv), '2026-08-24T12:00:00.000Z'),
	).toEqual(emitted(1))
	expect(dispatchedEvent(0)?.kind).toBe('entitlement')
})
