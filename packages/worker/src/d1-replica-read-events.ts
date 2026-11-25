/**
 * Countable D1 replica read telemetry. One Analytics Engine point per request
 * that read a replica session, written by `renderWithReplicaReads`, so the
 * `d1_replica_read_alert` lane can compute a retry rate. Points carry outcome
 * classes and the Cloudflare colo only: no paths, SQL, or user data.
 *
 * Production dataset `kody_d1_replica_read_events` (preview:
 * `kody_d1_replica_read_events_preview`), binding `D1_REPLICA_READ_EVENTS`.
 *
 * - blob1: retry reason (`none`, `write`, `read_failed`)
 * - blob2: final response (`ok`, `5xx`)
 * - blob3: document route (`ok`, `error`)
 * - blob4: Cloudflare colo, or empty
 * - double1: 1
 */

export type D1ReplicaRetryReason = 'write' | 'read_failed'

export type D1ReplicaReadOutcome = {
	retry?: D1ReplicaRetryReason
	status: number
	documentFailed: boolean
	colo?: string
}

export function buildD1ReplicaReadDataPoint(
	outcome: D1ReplicaReadOutcome,
): AnalyticsEngineDataPoint {
	return {
		blobs: [
			outcome.retry ?? 'none',
			outcome.status >= 500 ? '5xx' : 'ok',
			outcome.documentFailed ? 'error' : 'ok',
			(outcome.colo ?? '').slice(0, 8),
		],
		doubles: [1],
	}
}

export function resolveD1ReplicaReadEventsDataset(env: {
	SENTRY_ENVIRONMENT?: string
}) {
	return env.SENTRY_ENVIRONMENT === 'preview'
		? 'kody_d1_replica_read_events_preview'
		: 'kody_d1_replica_read_events'
}

function toAnalyticsDateTime(value: Date) {
	return value.toISOString().slice(0, 19).replace('T', ' ')
}

function windowWhere(input: { windowStart: Date; windowEnd: Date }) {
	return `timestamp >= toDateTime('${toAnalyticsDateTime(input.windowStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.windowEnd)}')`
}

/** Totals over the window, weighted by `_sample_interval`. */
export function buildD1ReplicaReadTotalsQuery(input: {
	dataset: string
	windowStart: Date
	windowEnd: Date
}) {
	return `SELECT
	SUM(_sample_interval) AS replica_reads,
	SUM(IF(blob1 != 'none', _sample_interval, 0)) AS retries,
	SUM(IF(blob1 = 'write', _sample_interval, 0)) AS write_retries,
	SUM(IF(blob1 = 'read_failed', _sample_interval, 0)) AS read_failures,
	SUM(IF(blob2 = '5xx', _sample_interval, 0)) AS failed_responses,
	SUM(IF(blob3 = 'error', _sample_interval, 0)) AS document_500s
FROM ${input.dataset}
WHERE ${windowWhere(input)}
FORMAT JSON`
}

/** Colos with the most retries or failures over the window. */
export function buildD1ReplicaReadColoQuery(input: {
	dataset: string
	windowStart: Date
	windowEnd: Date
}) {
	return `SELECT
	blob4 AS colo,
	SUM(IF(blob1 != 'none', _sample_interval, 0)) AS retries,
	SUM(IF(blob2 = '5xx', _sample_interval, 0)) AS failed_responses
FROM ${input.dataset}
WHERE ${windowWhere(input)}
	AND (blob1 != 'none' OR blob2 = '5xx')
GROUP BY colo
ORDER BY retries DESC
LIMIT 5
FORMAT JSON`
}

export type D1ReplicaReadCounts = {
	replicaReads: number
	retries: number
	writeRetries: number
	readFailures: number
	failedResponses: number
	document500s: number
}

type TotalsRow = Partial<
	Record<
		| 'replica_reads'
		| 'retries'
		| 'write_retries'
		| 'read_failures'
		| 'failed_responses'
		| 'document_500s',
		number | string | null
	>
>

function count(value: unknown) {
	const number = Math.round(Number(value ?? 0))
	return Number.isFinite(number) && number > 0 ? number : 0
}

export function parseD1ReplicaReadTotals(
	rows: Array<TotalsRow>,
): D1ReplicaReadCounts {
	const row = rows[0] ?? {}
	return {
		replicaReads: count(row.replica_reads),
		retries: count(row.retries),
		writeRetries: count(row.write_retries),
		readFailures: count(row.read_failures),
		failedResponses: count(row.failed_responses),
		document500s: count(row.document_500s),
	}
}

export type D1ReplicaReadColo = {
	colo: string
	retries: number
	failedResponses: number
}

export function parseD1ReplicaReadColos(
	rows: Array<{
		colo?: string | null
		retries?: number | string | null
		failed_responses?: number | string | null
	}>,
): Array<D1ReplicaReadColo> {
	return rows
		.map((row) => ({
			colo: String(row.colo ?? '').slice(0, 8),
			retries: count(row.retries),
			failedResponses: count(row.failed_responses),
		}))
		.filter((row) => /^[A-Z]{3,4}$/.test(row.colo))
}
