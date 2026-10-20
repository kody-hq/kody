import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { fleetPackageErrorRateKvKey } from '#worker/usage/fleet-package-error-rate.ts'

const queryAnalyticsEngineSql = vi.fn()
const dispatchFleetPackageErrorRateSubscriptionEvent = vi.fn(
	async (_input: { event: Record<string, unknown> }) => [],
)

vi.mock('#worker/usage/aggregate-rollups.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	queryAnalyticsEngineSql: (...args: Array<unknown>) =>
		queryAnalyticsEngineSql(...args),
}))

vi.mock('#worker/usage/fleet-package-error-rate-subscriptions.ts', () => ({
	dispatchFleetPackageErrorRateSubscriptionEvent: (input: {
		event: Record<string, unknown>
	}) => dispatchFleetPackageErrorRateSubscriptionEvent(input),
}))

const {
	fleetPackageErrorRateAlertKvKey,
	refreshFleetPackageErrorRateAndMaybeAlert,
} = await import('./fleet-package-error-rate-alerts.ts')

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-/
const alertNow = new Date('2026-08-22T19:32:00.000Z')

function createKv() {
	const stored = new Map<string, string>()
	return {
		stored,
		kv: {
			async get(key: string, type?: string) {
				const value = stored.get(key) ?? null
				if (value == null) return null
				return type === 'json' ? JSON.parse(value) : value
			},
			async put(key: string, value: string) {
				stored.set(key, value)
			},
		} as unknown as KVNamespace,
	}
}

function windows(
	eventCount: number,
	recentErrors: number,
	previousErrors: number,
) {
	return [
		['recent', recentErrors],
		['previous', previousErrors],
	].map(([window, errorCount]) => ({
		window,
		metric: 'package_export',
		event_count: eventCount,
		error_count: errorCount,
	}))
}

/** Elevated day window (16/80 vs 2/80) over a calm hour window. */
function elevatedDayRows(query: string) {
	return query.includes("toDateTime('2026-08-21 19:00:00')")
		? windows(80, 16, 2)
		: windows(40, 2, 1)
}

function alertEnv(kv: KVNamespace, APP_DB = {} as D1Database) {
	return {
		USAGE_EVENTS: {} as AnalyticsEngineDataset,
		APP_DB,
		BUNDLE_ARTIFACTS_KV: kv,
		APP_BASE_URL: 'https://kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
		SENTRY_ENVIRONMENT: 'production',
	}
}

function lastDispatchedEvent() {
	return dispatchFleetPackageErrorRateSubscriptionEvent.mock.calls.at(-1)?.[0]
		.event
}

test('refreshFleetPackageErrorRateAndMaybeAlert writes a content-free snapshot and pages once', async () => {
	consoleWarn.mockImplementation(() => {})
	const { stored, kv } = createKv()
	queryAnalyticsEngineSql.mockImplementation(async (input: { query: string }) =>
		elevatedDayRows(input.query),
	)

	const env = alertEnv(kv)
	expect(
		await refreshFleetPackageErrorRateAndMaybeAlert({ env, now: alertNow }),
	).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'notified', eventId: 'day:2026-08-22T19:00:00.000Z' },
	})
	expect(dispatchFleetPackageErrorRateSubscriptionEvent).toHaveBeenCalledTimes(
		1,
	)
	expect(lastDispatchedEvent()).toMatchObject({
		event: 'fleet.package_error_rate.elevated',
		concentration: null,
	})
	expect(
		JSON.parse(stored.get(fleetPackageErrorRateKvKey) ?? 'null'),
	).toMatchObject({
		environment: 'production',
		day: { recent: { combined: { errors: 16 } } },
		lastAlertEventId: 'day:2026-08-22T19:00:00.000Z',
		concentration: null,
	})

	expect(
		await refreshFleetPackageErrorRateAndMaybeAlert({
			env,
			now: new Date('2026-08-22T20:05:00.000Z'),
		}),
	).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'cooldown' },
	})
	expect(dispatchFleetPackageErrorRateSubscriptionEvent).toHaveBeenCalledTimes(
		1,
	)
	expect(
		JSON.parse(stored.get(fleetPackageErrorRateAlertKvKey) ?? 'null'),
	).toMatchObject({
		version: 1,
		alertedAtMs: alertNow.getTime(),
		windowKind: 'day',
		windowEnd: '2026-08-22T19:00:00.000Z',
		eventId: 'day:2026-08-22T19:00:00.000Z',
	})

	await expect(
		refreshFleetPackageErrorRateAndMaybeAlert({
			env: { BUNDLE_ARTIFACTS_KV: {} as KVNamespace },
		}),
	).resolves.toEqual({ status: 'skipped', reason: 'missing-analytics-config' })

	dispatchFleetPackageErrorRateSubscriptionEvent.mockRejectedValueOnce(
		new Error('fan-out failed'),
	)
	queryAnalyticsEngineSql.mockResolvedValue(windows(80, 16, 2))
	const failedKv = createKv()
	const { APP_BASE_URL: _baseUrl, ...envWithoutBaseUrl } = alertEnv(failedKv.kv)
	expect(
		await refreshFleetPackageErrorRateAndMaybeAlert({
			env: envWithoutBaseUrl,
			now: alertNow,
		}),
	).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'skipped', reason: 'notify_failed' },
	})
	expect(failedKv.stored.get(fleetPackageErrorRateAlertKvKey)).toBeUndefined()
})

test('refreshFleetPackageErrorRateAndMaybeAlert names a one-account concentration without leaking identifiers', async () => {
	consoleWarn.mockImplementation(() => {})
	const { stored, kv } = createKv()
	const kodyIdsByPackageId: Record<string, string> = {
		'11111111-1111-4111-8111-111111111111': 'dji-cloud-relay-staging-deploy',
		'22222222-2222-4222-8222-222222222222': 'earthranger-relay-staging-deploy',
		'33333333-3333-4333-8333-333333333333': 'analysis-staging-deploy',
	}
	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes('GROUP BY user_id, entity_id')) {
				return Object.keys(kodyIdsByPackageId).map((entityId, index) => ({
					user_id: ownerIdFromStored('jett-user'),
					entity_id: entityId,
					error_count: [40, 30, 20][index],
				}))
			}
			if (input.query.includes('blob1 AS user_id')) {
				return [{ user_id: ownerIdFromStored('jett-user'), error_count: 16 }]
			}
			return elevatedDayRows(input.query)
		},
	)
	const db = {
		prepare: (query: string) => ({
			bind: (...params: Array<unknown>) => ({
				async all() {
					if (query.includes('FROM users')) {
						return {
							results: params.includes('jett-user')
								? [{ stable_user_id: 'jett-user', username: 'jett' }]
								: [],
						}
					}
					if (query.includes('FROM saved_packages')) {
						return {
							results: params.flatMap((id) =>
								typeof id === 'string' && kodyIdsByPackageId[id]
									? [{ id, kody_id: kodyIdsByPackageId[id] }]
									: [],
							),
						}
					}
					return { results: [] }
				},
			}),
		}),
	} as unknown as D1Database

	expect(
		await refreshFleetPackageErrorRateAndMaybeAlert({
			env: alertEnv(kv, db),
			now: alertNow,
		}),
	).toMatchObject({
		status: 'refreshed',
		elevated: true,
		alert: { status: 'notified' },
	})
	const event = lastDispatchedEvent()
	expect(event?.concentration).toMatchObject({
		kind: 'one_account',
		owners: [
			{
				username: 'jett',
				packages: Object.values(kodyIdsByPackageId).map((kody_id) => ({
					kody_id,
				})),
			},
		],
	})
	const payload = JSON.stringify(event)
	expect(payload).not.toContain('user_id')
	expect(payload).not.toContain('jett-user')
	expect(payload).not.toMatch(uuidPattern)
	expect(consoleWarn).toHaveBeenCalledWith(
		'fleet-package-error-rate-alerted',
		expect.objectContaining({ concentration: expect.any(String) }),
	)
	const snapshot = stored.get(fleetPackageErrorRateKvKey) ?? 'null'
	expect(JSON.parse(snapshot)?.concentration?.kind).toBe('one_account')
	expect(snapshot).not.toContain('user_id')
	expect(snapshot).not.toMatch(uuidPattern)
})
