import { beforeEach, expect, test, vi } from 'vitest'
import {
	buildD1ReplicaReadAlertEvent,
	checkD1ReplicaReadsAndAlert,
	d1ReplicaReadAlertKvKey,
	decideD1ReplicaReadAlert,
	type D1ReplicaReadAlertState,
} from '#worker/d1-replica-read-alert.ts'
import type { D1ReplicaReadCounts } from '#worker/d1-replica-read-events.ts'

const dispatch = vi.hoisted(() => vi.fn())
vi.mock('#worker/package-invocations/admin-package-subscriptions.ts', () => ({
	dispatchAdminPackageSubscriptionEvent: dispatch,
}))

const now = new Date('2026-11-25T00:30:00Z')
const minutes = (count: number) => count * 60_000

function counts(input: Partial<D1ReplicaReadCounts>): D1ReplicaReadCounts {
	return {
		replicaReads: 0,
		retries: 0,
		writeRetries: 0,
		readFailures: 0,
		failedResponses: 0,
		document500s: 0,
		...input,
	}
}

test('below every threshold does not alert', () => {
	expect(
		decideD1ReplicaReadAlert({
			counts: counts({
				replicaReads: 4900,
				retries: 49,
				document500s: 2,
			}),
			state: null,
			now,
		}),
	).toEqual({ action: 'below_threshold', retryRatePercent: 1 })
})

test('a retry rate over 1% alerts once there is enough traffic', () => {
	const decision = decideD1ReplicaReadAlert({
		counts: counts({ replicaReads: 1000, retries: 11 }),
		state: null,
		now,
	})
	expect(decision).toMatchObject({
		action: 'notify',
		retryRatePercent: 1.1,
		triggers: ['retry_rate'],
		incidentKey: 'd1-replica-alert-2026-11-25-00',
	})
	// The same rate on too little traffic is noise.
	expect(
		decideD1ReplicaReadAlert({
			counts: counts({ replicaReads: 199, retries: 10 }),
			state: null,
			now,
		}).action,
	).toBe('below_threshold')
})

test('an absolute retry burst alerts whatever the rate', () => {
	expect(
		decideD1ReplicaReadAlert({
			counts: counts({ replicaReads: 100_000, retries: 50 }),
			state: null,
			now,
		}),
	).toMatchObject({ action: 'notify', triggers: ['retry_burst'] })
})

test('document route 500s on replica reads alert', () => {
	expect(
		decideD1ReplicaReadAlert({
			counts: counts({ replicaReads: 50, document500s: 3 }),
			state: null,
			now,
		}),
	).toMatchObject({ action: 'notify', triggers: ['document_500s'] })
})

test('a sustained spike keeps one incident and waits out the cooldown', () => {
	const breach = counts({ replicaReads: 1000, retries: 60 })
	const state: D1ReplicaReadAlertState = {
		incidentKey: 'd1-replica-alert-2026-11-24-23',
		notifiedAt: now.getTime() - minutes(40),
		lastBreachAt: now.getTime() - minutes(5),
	}
	expect(decideD1ReplicaReadAlert({ counts: breach, state, now })).toEqual({
		action: 'cooldown',
		retryRatePercent: 6,
		triggers: ['retry_rate', 'retry_burst'],
		incidentKey: 'd1-replica-alert-2026-11-24-23',
		nextState: { ...state, lastBreachAt: now.getTime() },
	})
	// After the cooldown it sends again for the same incident (same card).
	expect(
		decideD1ReplicaReadAlert({
			counts: breach,
			state: { ...state, notifiedAt: now.getTime() - minutes(60) },
			now,
		}),
	).toMatchObject({
		action: 'notify',
		incidentKey: 'd1-replica-alert-2026-11-24-23',
	})
	// A breach after a quiet gap is a new incident.
	expect(
		decideD1ReplicaReadAlert({
			counts: breach,
			state: { ...state, lastBreachAt: now.getTime() - minutes(31) },
			now,
		}),
	).toMatchObject({
		action: 'notify',
		incidentKey: 'd1-replica-alert-2026-11-25-00',
	})
})

test('the event carries numbers, the card, and the kill switch only', () => {
	const event = buildD1ReplicaReadAlertEvent({
		counts: counts({
			replicaReads: 1000,
			retries: 20,
			writeRetries: 5,
			readFailures: 15,
			failedResponses: 4,
			document500s: 3,
		}),
		colos: [{ colo: 'DFW', retries: 12, failedResponses: 3 }],
		retryRatePercent: 2,
		triggers: ['retry_rate', 'document_500s'],
		incidentKey: 'd1-replica-alert-2026-11-25-00',
		windowStart: new Date('2026-11-25T00:15:00Z'),
		windowEnd: new Date('2026-11-25T00:30:00Z'),
	})
	expect(event).toMatchObject({
		event: 'd1.replica_reads.alert',
		window_minutes: 15,
		replica_reads: 1000,
		retries: 20,
		retry_rate_percent: 2,
		failed_responses: 4,
		document_500s: 3,
		kill_switch:
			'Set feature flag d1-replica-reads to enabled:false (Cole flips flags).',
		card: {
			project: 'kody',
			repo: 'kody-hq/kody',
			labels: ['area:platform', 'observability', 'agent-ready', 'P1'],
			priority: 1,
			idempotency_key: 'd1-replica-alert-2026-11-25-00',
		},
	})
	expect(event.card.body).toMatch(/^D1 replica alert: 20 of 1000 replica reads/)
	expect(event.card.body).toContain('DFW (12 retries, 3 5xx)')
	expect(event.card.body).toContain(
		'Kill switch: Set feature flag d1-replica-reads to enabled:false',
	)
})

function kv() {
	const values = new Map<string, string>()
	return {
		values,
		get: vi.fn(async (key: string) => values.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			values.set(key, value)
		}),
	}
}

function analytics(totals: Record<string, number>) {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		const body = String(init?.body)
		const data = body.includes('GROUP BY colo')
			? [{ colo: 'DFW', retries: 9, failed_responses: 0 }]
			: [totals]
		return new Response(JSON.stringify({ data }))
	})
}

function env(store: ReturnType<typeof kv>) {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: store as unknown as KVNamespace,
		APP_BASE_URL: 'https://kody.codes',
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
		D1_REPLICA_READ_EVENTS: {} as AnalyticsEngineDataset,
	}
}

beforeEach(() => {
	dispatch.mockReset()
	vi.spyOn(console, 'warn').mockImplementation(() => {})
})

test('the lane fans one event per breach, then holds during the cooldown', async () => {
	vi.stubGlobal('fetch', analytics({ replica_reads: 900, retries: 18 }))
	const store = kv()
	dispatch.mockResolvedValue([])

	expect(
		await checkD1ReplicaReadsAndAlert({ env: env(store), now }),
	).toMatchObject({
		status: 'notified',
		replicaReads: 900,
		retries: 18,
		retryRatePercent: 2,
	})
	expect(dispatch).toHaveBeenCalledTimes(1)
	const params = await dispatch.mock.calls[0]![0].getParams()
	expect(params).toMatchObject({
		event: 'd1.replica_reads.alert',
		colos: [{ colo: 'DFW', retries: 9, failed_responses: 0 }],
	})
	expect(JSON.parse(store.values.get(d1ReplicaReadAlertKvKey)!)).toEqual({
		incidentKey: 'd1-replica-alert-2026-11-25-00',
		notifiedAt: now.getTime(),
		lastBreachAt: now.getTime(),
	})

	const later = new Date(now.getTime() + minutes(5))
	expect(
		await checkD1ReplicaReadsAndAlert({ env: env(store), now: later }),
	).toMatchObject({ status: 'cooldown' })
	expect(dispatch).toHaveBeenCalledTimes(1)
	vi.unstubAllGlobals()
})

test('a failed dispatch does not start the cooldown', async () => {
	vi.stubGlobal('fetch', analytics({ replica_reads: 100, retries: 50 }))
	const store = kv()
	dispatch.mockRejectedValue(new Error('down'))
	expect(await checkD1ReplicaReadsAndAlert({ env: env(store), now })).toEqual({
		status: 'skipped',
		reason: 'notify_failed',
	})
	expect(store.put).not.toHaveBeenCalled()
	vi.unstubAllGlobals()
})

test('without the dataset or API token the lane skips', async () => {
	expect(
		await checkD1ReplicaReadsAndAlert({
			env: { ...env(kv()), CLOUDFLARE_API_TOKEN: undefined },
			now,
		}),
	).toEqual({ status: 'skipped', reason: 'missing-analytics-config' })
})
