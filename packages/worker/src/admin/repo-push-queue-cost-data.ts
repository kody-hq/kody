/**
 * Aggregate cost and outcome numbers for plain-repo pushes (`git_push` usage
 * events), split by receive-pack path: `queued` (repo-push-queue Durable
 * Object) vs `direct` (isolate-local wait-and-retry proxy). Read by the
 * `adminRepoPushQueueCost` capability.
 *
 * Aggregates only: no owner ids, usernames, or repo ids leave this module.
 * Per-path breakdowns come from Analytics Engine SQL (production/preview);
 * `monthRollup` comes from the D1 `usage_rollups` table (hourly from AE in
 * production, written directly in local dev) and has no path split.
 */

import { resolveAdminFleetErrorRateWindow } from '#worker/admin/fleet-error-rate-data.ts'
import {
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
} from '#worker/usage/aggregate-rollups.ts'
import {
	type ReceivePackOutcomeKind,
	type ReceivePackPath,
} from '#worker/repo/receive-pack-metrics.ts'

export const repoPushQueueCostDefaultDays = 7
export const repoPushQueueCostMaxDays = 31

export const receivePackPaths = [
	'queued',
	'direct',
] as const satisfies ReadonlyArray<ReceivePackPath>

export type RepoPushQueueCostPath = {
	path: ReceivePackPath
	pushes: number
	ok: number
	busy: number
	timeout: number
	error: number
	/** (busy + timeout + error) / pushes; null with no pushes. */
	failureRate: number | null
	/** (busy + timeout) / pushes; null with no pushes. */
	busyOrTimeoutRate: number | null
	avgWallMs: number | null
	maxWallMs: number
	/**
	 * Sum of per-push wall time. For `queued` this is an upper bound on
	 * Durable Object active time: concurrent pushes to one repo overlap.
	 */
	totalWallSeconds: number
	avgWaitMs: number | null
	maxWaitMs: number
	avgAttempts: number | null
	/** Pushes that needed more than one Artifacts send (busy retries). */
	retriedPushes: number
	/** Queue depth on arrival; always 0 on `direct`. */
	avgQueueDepth: number | null
	maxQueueDepth: number
}

export type RepoPushQueueCostErrorRow = {
	path: ReceivePackPath
	errorName: string
	outcome: Exclude<ReceivePackOutcomeKind, 'ok'>
	pushes: number
}

export type RepoPushQueueCostMonthRollup = {
	month: string
	pushes: number
	errors: number
	failureRate: number | null
	avgWallMs: number | null
}

export type RepoPushQueueCostData = {
	days: number
	startDay: string
	endDay: string
	available: boolean
	reason: string | null
	paths: Array<RepoPushQueueCostPath>
	errors: Array<RepoPushQueueCostErrorRow>
	monthRollup: RepoPushQueueCostMonthRollup | null
}

export type RepoPushQueueCostAnalyticsRow = {
	path: string
	error_name: string
	pushes: number | string
	wall_ms: number | string
	max_wall_ms: number | string
	wait_ms: number | string
	max_wait_ms: number | string
	depth_sum: number | string
	max_depth: number | string
	attempts_sum: number | string
	retried: number | string
}

type RepoPushQueueCostEnv = {
	APP_DB?: D1Database
	USAGE_EVENTS?: AnalyticsEngineDataset
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
	WRANGLER_IS_LOCAL_DEV?: string
}

/** Double positions match `usageEventDoubleIndexes` in record-usage.ts. */
export function buildRepoPushQueueCostQuery(input: {
	dataset: string
	startDay: string
	nextDay: string
}) {
	return `
SELECT
	blob3 AS path,
	blob13 AS error_name,
	sum(_sample_interval) AS pushes,
	sum(double1 * _sample_interval) AS wall_ms,
	max(double1) AS max_wall_ms,
	sum(double6 * _sample_interval) AS wait_ms,
	max(double6) AS max_wait_ms,
	sum(double7 * _sample_interval) AS depth_sum,
	max(double7) AS max_depth,
	sum(double8 * _sample_interval) AS attempts_sum,
	sum(if(double8 > 1, 1.0, 0.0) * _sample_interval) AS retried
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${input.startDay} 00:00:00')
	AND timestamp < toDateTime('${input.nextDay} 00:00:00')
	AND blob2 = 'git_push'
GROUP BY blob3, blob13
FORMAT JSON
`.trim()
}

function toNumber(value: number | string | undefined) {
	const parsed = Number(value ?? 0)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function ratio(numerator: number, denominator: number) {
	return denominator > 0 ? numerator / denominator : null
}

export function outcomeForGitPushErrorName(
	errorName: string,
): ReceivePackOutcomeKind {
	if (errorName === '') return 'ok'
	if (errorName === 'busy') return 'busy'
	if (errorName === 'timeout') return 'timeout'
	return 'error'
}

function emptyTotals() {
	return {
		pushes: 0,
		ok: 0,
		busy: 0,
		timeout: 0,
		error: 0,
		wallMs: 0,
		maxWallMs: 0,
		waitMs: 0,
		maxWaitMs: 0,
		depthSum: 0,
		maxDepth: 0,
		attemptsSum: 0,
		retried: 0,
	}
}

export function foldRepoPushQueueCostRows(
	rows: ReadonlyArray<RepoPushQueueCostAnalyticsRow>,
): Pick<RepoPushQueueCostData, 'paths' | 'errors'> {
	const totals = new Map(
		receivePackPaths.map((path) => [path, emptyTotals()] as const),
	)
	const errors: Array<RepoPushQueueCostErrorRow> = []
	for (const row of rows) {
		const path = receivePackPaths.find((candidate) => candidate === row.path)
		if (!path) continue
		const errorName = String(row.error_name ?? '')
		const outcome = outcomeForGitPushErrorName(errorName)
		const pushes = Math.round(toNumber(row.pushes))
		const side = totals.get(path)!
		side.pushes += pushes
		side[outcome] += pushes
		side.wallMs += toNumber(row.wall_ms)
		side.maxWallMs = Math.max(side.maxWallMs, toNumber(row.max_wall_ms))
		side.waitMs += toNumber(row.wait_ms)
		side.maxWaitMs = Math.max(side.maxWaitMs, toNumber(row.max_wait_ms))
		side.depthSum += toNumber(row.depth_sum)
		side.maxDepth = Math.max(side.maxDepth, toNumber(row.max_depth))
		side.attemptsSum += toNumber(row.attempts_sum)
		side.retried += Math.round(toNumber(row.retried))
		if (outcome !== 'ok' && pushes > 0) {
			errors.push({ path, errorName, outcome, pushes })
		}
	}
	errors.sort((a, b) => b.pushes - a.pushes)
	return {
		paths: receivePackPaths.map((path) => {
			const side = totals.get(path)!
			return {
				path,
				pushes: side.pushes,
				ok: side.ok,
				busy: side.busy,
				timeout: side.timeout,
				error: side.error,
				failureRate: ratio(side.busy + side.timeout + side.error, side.pushes),
				busyOrTimeoutRate: ratio(side.busy + side.timeout, side.pushes),
				avgWallMs: ratio(side.wallMs, side.pushes),
				maxWallMs: side.maxWallMs,
				totalWallSeconds: side.wallMs / 1000,
				avgWaitMs: ratio(side.waitMs, side.pushes),
				maxWaitMs: side.maxWaitMs,
				avgAttempts: ratio(side.attemptsSum, side.pushes),
				retriedPushes: side.retried,
				avgQueueDepth: ratio(side.depthSum, side.pushes),
				maxQueueDepth: side.maxDepth,
			}
		}),
		errors,
	}
}

async function loadMonthRollup(
	db: D1Database | undefined,
	now: Date,
): Promise<RepoPushQueueCostMonthRollup | null> {
	if (!db || typeof db.prepare !== 'function') return null
	const month = now.toISOString().slice(0, 'YYYY-MM'.length)
	try {
		const row = await db
			.prepare(
				`SELECT COALESCE(SUM(event_count), 0) AS pushes,
					COALESCE(SUM(error_count), 0) AS errors,
					COALESCE(SUM(total_duration_ms), 0) AS duration_ms
				 FROM usage_rollups
				 WHERE metric = 'git_push' AND month = ?`,
			)
			.bind(month)
			.first<{ pushes: number; errors: number; duration_ms: number }>()
		const pushes = toNumber(row?.pushes)
		const errors = toNumber(row?.errors)
		return {
			month,
			pushes,
			errors,
			failureRate: ratio(errors, pushes),
			avgWallMs: ratio(toNumber(row?.duration_ms), pushes),
		}
	} catch (error) {
		console.warn('repo-push-queue-cost-rollup-failed', error)
		return null
	}
}

export async function loadRepoPushQueueCost(input: {
	env: RepoPushQueueCostEnv
	days?: number
	now?: Date
}): Promise<RepoPushQueueCostData> {
	const now = input.now ?? new Date()
	const window = resolveAdminFleetErrorRateWindow({
		days: Math.min(
			repoPushQueueCostMaxDays,
			input.days ?? repoPushQueueCostDefaultDays,
		),
		now,
	})
	const monthRollup = await loadMonthRollup(input.env.APP_DB, now)
	const base = {
		days: window.days,
		startDay: window.startDay,
		endDay: window.endDay,
		monthRollup,
	}
	const unavailable = (reason: string): RepoPushQueueCostData => ({
		...base,
		available: false,
		reason,
		...foldRepoPushQueueCostRows([]),
	})
	if (input.env.WRANGLER_IS_LOCAL_DEV === 'true') {
		return unavailable(
			'Per-path breakdown needs Analytics Engine SQL, which local dev cannot read; monthRollup and the repo-push-queue flag readout still work locally.',
		)
	}
	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!input.env.USAGE_EVENTS || !accountId || !apiToken) {
		return unavailable(
			'USAGE_EVENTS or Analytics Engine SQL credentials (CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN) are not configured.',
		)
	}
	try {
		const rows = await queryAnalyticsEngineSql<RepoPushQueueCostAnalyticsRow>({
			accountId,
			apiToken,
			baseUrl:
				input.env.CLOUDFLARE_API_BASE_URL?.trim() ||
				'https://api.cloudflare.com',
			query: buildRepoPushQueueCostQuery({
				dataset: resolveUsageEventsDataset(input.env),
				startDay: window.startDay,
				nextDay: window.nextDay,
			}),
		})
		return {
			...base,
			available: true,
			reason: null,
			...foldRepoPushQueueCostRows(rows),
		}
	} catch (error) {
		console.warn('repo-push-queue-cost-query-failed', error)
		const detail = error instanceof Error ? error.message : String(error)
		return unavailable(`Analytics Engine query failed: ${detail.slice(0, 600)}`)
	}
}
