import { waitUntil } from 'cloudflare:workers'
import {
	recordUsage,
	type UsageEnv,
	type UsageOutcome,
} from './record-usage.ts'

export const durableObjectGbSecondsEventType = 'durable_object_gb_seconds'

/** Coalesced Durable Object metrics that share one burst queue. */
type DurableObjectUsageEventType =
	| typeof durableObjectGbSecondsEventType
	| 'durable_object_rows_read'
	| 'durable_object_platform_rows_read'

/**
 * Wait after the last RPC in a burst before writing one Analytics Engine
 * point. Sequential StorageRunner calls in one request then share a single
 * `writeDataPoint` instead of competing with `package_static_call` and
 * `outbound_fetch` for the per-invocation budget.
 */
export const durableObjectUsageCoalesceDelayMs = 25

/** Force a write if same-outcome RPCs keep resetting the debounce timer. */
export const durableObjectUsageMaxBurstMs = 5_000

type PendingDurableObjectUsage = {
	env: UsageEnv
	eventType: DurableObjectUsageEventType
	userId: string
	doClass: string
	outcome: UsageOutcome
	durationMs: number
	eventCount: number
	/** Package id when known; empty string coalesces with unset (Ad hoc). */
	packageId: string
	packageAppVisitorUserId?: string
	/** The app's owning org when `userId` is a visiting org (ADR 0095). */
	packageAppOwnerOrgId?: string
	/** First queued event in this bucket; the flush writes this timestamp. */
	timestamp: string
}

const pendingByKey = new Map<string, PendingDurableObjectUsage>()
let coalesceTimer: ReturnType<typeof setTimeout> | null = null
let flushWaitUntil: (() => void) | null = null
let inFlightFlush: Promise<void> | null = null
let burstStartedAt: number | null = null

/**
 * Wrap a per-user Durable Object RPC stub so method calls record observe-only
 * `durable_object_gb_seconds` events. `durationMs` is RPC wall-clock; admin
 * display converts that to GB-s at the default 128 MB. Same-outcome RPCs in
 * one burst coalesce into a single write. Recording failures never surface
 * to the caller. Without `USAGE_EVENTS` the stub is returned unchanged so
 * local/test mocks that lack Analytics Engine do not attempt a D1 rollup.
 *
 * The wrapper must not use the RpcStub as the Proxy target or as `this` for
 * method getters. Cloudflare RPC binds stub methods to the receiver; a
 * Proxy-of-stub is not a valid RPC receiver and every call then throws
 * "Proxy could not be serialized because it is not a valid RPC receiver
 * type" — including `packageStorage()` get of a missing key.
 */
export function createMeteredDurableObjectStub<T extends object>(input: {
	env: UsageEnv
	userId: string
	doClass: string
	stub: T
}): T {
	if (!input.env.USAGE_EVENTS) return input.stub
	const stub = input.stub
	return new Proxy({} as T, {
		get(_target, prop) {
			if (prop === 'then') return undefined
			const value = Reflect.get(stub, prop, stub)
			if (typeof value !== 'function') return value
			return (...args: Array<unknown>) => {
				const startedAt = Date.now()
				let outcome: UsageOutcome = 'success'
				const finish = () => {
					try {
						queueDurableObjectUsage({
							env: input.env,
							eventType: durableObjectGbSecondsEventType,
							userId: input.userId,
							doClass: input.doClass,
							outcome,
							durationMs: Date.now() - startedAt,
							units: 1,
						})
					} catch (error) {
						console.debug('durable-object-usage-failed', error)
					}
				}
				try {
					const result = Reflect.apply(value, stub, args) as unknown
					if (result && typeof result === 'object' && 'then' in result) {
						return Promise.resolve(result).then(
							(resolved) => {
								finish()
								return resolved
							},
							(error: unknown) => {
								outcome = 'error'
								finish()
								throw error
							},
						)
					}
					finish()
					return result
				} catch (error) {
					outcome = 'error'
					finish()
					throw error
				}
			}
		},
	})
}

/**
 * Flush queued Durable Object duration now. Tests call this instead of
 * waiting for the coalesce timer; production waitUntil uses the same path.
 */
export async function flushDurableObjectUsageWrites(): Promise<void> {
	if (coalesceTimer != null) {
		clearTimeout(coalesceTimer)
		coalesceTimer = null
	}
	burstStartedAt = null
	const pending = flushWaitUntil
	flushWaitUntil = null
	try {
		await flushQueuedDurableObjectUsage()
	} finally {
		pending?.()
	}
}

/**
 * Queue SQLite rows read by a per-user Durable Object into the same burst
 * as duration, so a run that issues many storage reads writes one Analytics
 * Engine point per (user, class, metric, outcome) instead of one per call.
 * Without `USAGE_EVENTS` (local dev, tests) it records directly so the D1
 * rollup fallback still sees each read.
 */
export function queueDurableObjectRowsRead(input: {
	env: UsageEnv
	eventType: 'durable_object_rows_read' | 'durable_object_platform_rows_read'
	userId: string
	doClass: string
	rowsRead: number
	outcome?: UsageOutcome
	packageId?: string | null
	packageAppVisitorUserId?: string
	packageAppOwnerOrgId?: string
}): void {
	try {
		if (!input.userId) return
		if (!Number.isFinite(input.rowsRead) || input.rowsRead < 1) return
		const rowsRead = Math.trunc(input.rowsRead)
		const outcome = input.outcome ?? 'success'
		const packageId = input.packageId?.trim() || ''
		const packageAppVisitorUserId = input.packageAppVisitorUserId
		if (!input.env.USAGE_EVENTS) {
			recordUsage(input.env, {
				userId: input.userId,
				eventType: input.eventType,
				entityId: input.doClass,
				eventCount: rowsRead,
				outcome,
				...(packageId ? { packageId } : {}),
				...(packageAppVisitorUserId !== undefined
					? { packageAppVisitorUserId }
					: {}),
				...(input.packageAppOwnerOrgId
					? { packageAppOwnerOrgId: input.packageAppOwnerOrgId }
					: {}),
			}).catch((error: unknown) => {
				console.debug('durable-object-rows-read-failed', error)
			})
			return
		}
		queueDurableObjectUsage({
			env: input.env,
			eventType: input.eventType,
			userId: input.userId,
			doClass: input.doClass,
			outcome,
			durationMs: 0,
			units: rowsRead,
			packageId,
			packageAppVisitorUserId,
			packageAppOwnerOrgId: input.packageAppOwnerOrgId,
		})
	} catch (error) {
		console.debug('durable-object-rows-read-failed', error)
	}
}

function queueDurableObjectUsage(input: {
	env: UsageEnv
	eventType: DurableObjectUsageEventType
	userId: string
	doClass: string
	outcome: UsageOutcome
	durationMs: number
	units: number
	packageId?: string
	packageAppVisitorUserId?: string
	packageAppOwnerOrgId?: string
}) {
	const timestamp = new Date().toISOString()
	// Buckets never span a UTC month, so a burst that crosses midnight on the
	// last day cannot move earlier units into the next month's rollup.
	const month = timestamp.slice(0, 'YYYY-MM'.length)
	const packageId = input.packageId?.trim() || ''
	const packageAppVisitorUserId = input.packageAppVisitorUserId
	const visitorKey =
		packageAppVisitorUserId === undefined
			? ''
			: `visitor:${packageAppVisitorUserId}`
	const ownerOrgId = input.packageAppOwnerOrgId?.trim() || ''
	const key = `${input.eventType}\0${input.userId}\0${input.doClass}\0${input.outcome}\0${month}\0${packageId}\0${visitorKey}\0${ownerOrgId}`
	const existing = pendingByKey.get(key)
	if (existing) {
		existing.durationMs += input.durationMs
		existing.eventCount += input.units
	} else {
		pendingByKey.set(key, {
			env: input.env,
			eventType: input.eventType,
			userId: input.userId,
			doClass: input.doClass,
			outcome: input.outcome,
			durationMs: input.durationMs,
			eventCount: input.units,
			packageId,
			...(packageAppVisitorUserId !== undefined
				? { packageAppVisitorUserId }
				: {}),
			...(ownerOrgId ? { packageAppOwnerOrgId: ownerOrgId } : {}),
			timestamp,
		})
	}
	scheduleDurableObjectUsageFlush()
}

function scheduleDurableObjectUsageFlush() {
	if (coalesceTimer != null) {
		clearTimeout(coalesceTimer)
	}
	if (burstStartedAt == null) burstStartedAt = Date.now()
	const remainingMs = Math.max(
		0,
		durableObjectUsageMaxBurstMs - (Date.now() - burstStartedAt),
	)
	if (remainingMs === 0) {
		void flushDurableObjectUsageWrites()
		return
	}
	if (flushWaitUntil == null) {
		let resolveFlush: (() => void) | undefined
		const keepAlive = new Promise<void>((resolve) => {
			resolveFlush = resolve
		})
		try {
			waitUntil(keepAlive)
			flushWaitUntil = resolveFlush ?? null
		} catch (error) {
			console.debug('durable-object-usage-waituntil-failed', error)
		}
	}
	coalesceTimer = setTimeout(
		() => {
			coalesceTimer = null
			void flushDurableObjectUsageWrites()
		},
		Math.min(durableObjectUsageCoalesceDelayMs, remainingMs),
	)
}

async function flushQueuedDurableObjectUsage() {
	if (inFlightFlush) {
		await inFlightFlush
		if (pendingByKey.size === 0) return
	}
	const buckets = [...pendingByKey.values()]
	pendingByKey.clear()
	if (buckets.length === 0) return
	const flush = Promise.all(
		buckets.map((bucket) =>
			recordUsage(bucket.env, {
				userId: bucket.userId,
				eventType: bucket.eventType,
				entityId: bucket.doClass,
				...(bucket.eventType === durableObjectGbSecondsEventType
					? { durationMs: bucket.durationMs }
					: {}),
				eventCount: bucket.eventCount,
				outcome: bucket.outcome,
				timestamp: bucket.timestamp,
				...(bucket.packageId ? { packageId: bucket.packageId } : {}),
				...(bucket.packageAppVisitorUserId !== undefined
					? { packageAppVisitorUserId: bucket.packageAppVisitorUserId }
					: {}),
				...(bucket.packageAppOwnerOrgId
					? { packageAppOwnerOrgId: bucket.packageAppOwnerOrgId }
					: {}),
			}),
		),
	).then(() => undefined)
	inFlightFlush = flush
	try {
		await flush
	} finally {
		if (inFlightFlush === flush) inFlightFlush = null
	}
}
