import { queueDurableObjectRowsRead } from './durable-object-usage.ts'
import { type UsageEnv } from './record-usage.ts'

export const durableObjectRowsReadEventType = 'durable_object_rows_read'
export const durableObjectPlatformRowsReadEventType =
	'durable_object_platform_rows_read'

/**
 * Record customer-controlled Durable Object SQLite rows read (StorageRunner
 * SQL and key-value reads). This is the monthly include / overage meter.
 * Coalesced per burst; never throws. Zero-row reads are skipped so a no-op
 * query cannot inflate the count by the `eventCount` floor of 1.
 */
export function recordDurableObjectRowsRead(input: {
	env: UsageEnv
	userId: string
	doClass: string
	rowsRead: number
	outcome?: 'success' | 'error'
	/** Saved package id when the StorageRunner bucket is package-owned. */
	packageId?: string | null
	/** Present for package-app visitor reads; empty string means anonymous. */
	packageAppVisitorUserId?: string
	/** The app's owning org when `userId` is a visiting org (ADR 0095). */
	packageAppOwnerOrgId?: string
}): void {
	queueDurableObjectRowsRead({
		...input,
		eventType: durableObjectRowsReadEventType,
	})
}

/**
 * Record rows read by a Kody-owned per-user Durable Object (RunLog run
 * history). Observe-only cost visibility: never part of the include or
 * overage math, because the query shapes are Kody's, not the customer's.
 * Only recorded with Analytics Engine bound: the local D1 fallback would add
 * one rollup upsert per RunLog statement.
 */
export function recordDurableObjectPlatformRowsRead(input: {
	env: UsageEnv
	userId: string
	doClass: string
	rowsRead: number
}): void {
	if (!input.env.USAGE_EVENTS) return
	queueDurableObjectRowsRead({
		...input,
		eventType: durableObjectPlatformRowsReadEventType,
	})
}
