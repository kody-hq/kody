import { chunkArray } from '@kody-internal/shared/chunk.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	queryAnalyticsEngineSql,
	resolveUsageEventsDataset,
} from './aggregate-rollups.ts'
import { fleetPackageErrorRateMetrics } from './fleet-package-error-rate-subscription-event.ts'

/**
 * Sustained platform alert: distinct actors who hit ≥1 errored package-runtime
 * event in a 15-minute window, compared to a trailing 7-day median baseline.
 * Single-owner noise that only hurts one actor stays under the volume floor.
 */

export const fleetUsersAffectedKvKey = 'ops-alert:fleet-users-affected:v1'
export const fleetUsersAffectedHistoryKvKey =
	'ops-alert:fleet-users-affected:history:v1'

export const fleetUsersAffectedWindowMs = 15 * 60 * 1000
export const fleetUsersAffectedBaselineWindows = (7 * 24 * 60) / 15 // 672
export const fleetUsersAffectedMinAffected = 5
export const fleetUsersAffectedBaselineFactor = 2
/** Absolute fraction above baseline (affected/active) required to fire. */
export const fleetUsersAffectedMinFractionDelta = 0.05
export const fleetUsersAffectedConsecutiveWindowsToFire = 2
export const fleetUsersAffectedConsecutiveWindowsToResolve = 2
export const fleetUsersAffectedMaxNamedPackages = 8
export const fleetUsersAffectedMaxHistorySamples =
	fleetUsersAffectedBaselineWindows

const analyticsEngineIdPattern = /^[A-Za-z0-9:._-]+$/
const maxSqlBindingsPerChunk = 90
export const fleetUsersAffectedStateTtlSeconds = 14 * 24 * 60 * 60
const stateTtlSeconds = fleetUsersAffectedStateTtlSeconds

export type FleetUsersAffectedEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB?: D1Database
	BUNDLE_ARTIFACTS_KV?: KVNamespace
	APP_BASE_URL?: string
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_TOKEN?: string
	CLOUDFLARE_API_BASE_URL?: string
	SENTRY_ENVIRONMENT?: string
	CF_VERSION_METADATA?: { id?: string; timestamp?: string }
}

export type FleetUsersAffectedWindowMetrics = {
	windowStart: string
	windowEnd: string
	affectedUsers: number
	activeUsers: number
	fraction: number | null
	packages: Array<{
		kody_id: string
		affected_users: number
		share: number
	}>
	byMetric: Array<{
		metric: (typeof fleetPackageErrorRateMetrics)[number]
		affected_users: number
	}>
	dominantPackage: {
		kody_id: string
		affected_users: number
		share: number
	} | null
}

export type FleetUsersAffectedIncidentStatus = 'ok' | 'firing'

export type FleetUsersAffectedState = {
	version: 1
	status: FleetUsersAffectedIncidentStatus
	consecutiveElevatedWindows: number
	consecutiveClearWindows: number
	incidentStartedAt: string | null
	lastWindowEnd: string | null
	lastMetrics: FleetUsersAffectedWindowMetrics | null
	baselineAffectedMedian: number | null
	baselineFractionMedian: number | null
	/** Set until elevate/resolve admin dispatch succeeds; enables same-window replay. */
	pendingNotify: FleetUsersAffectedTransitionAction | null
}

export type FleetUsersAffectedHistory = {
	version: 1
	samples: Array<{
		windowEnd: string
		affectedUsers: number
		activeUsers: number
		fraction: number | null
	}>
}

export type FleetUsersAffectedTransitionAction = 'none' | 'elevate' | 'resolve'

export type FleetUsersAffectedTransition = {
	next: FleetUsersAffectedState
	action: FleetUsersAffectedTransitionAction
	elevated: boolean
	/** Incident start preserved for resolve emails after state re-arms. */
	resolvedIncidentStartedAt: string | null
}

export function alignToUtcWindow(now: Date, windowMs: number) {
	const ms = now.getTime()
	return new Date(Math.floor(ms / windowMs) * windowMs)
}

export function medianOf(values: ReadonlyArray<number>): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((left, right) => left - right)
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1]! + sorted[mid]!) / 2
	}
	return sorted[mid]!
}

export function isFleetUsersAffectedElevated(input: {
	affectedUsers: number
	activeUsers: number
	baselineAffectedMedian: number | null
	baselineFractionMedian: number | null
	minAffected?: number
	baselineFactor?: number
	minFractionDelta?: number
}) {
	const minAffected = input.minAffected ?? fleetUsersAffectedMinAffected
	const baselineFactor =
		input.baselineFactor ?? fleetUsersAffectedBaselineFactor
	const minFractionDelta =
		input.minFractionDelta ?? fleetUsersAffectedMinFractionDelta
	const baseline = Math.max(0, input.baselineAffectedMedian ?? 0)
	const affectedFloor = Math.max(minAffected, baselineFactor * baseline)
	if (input.affectedUsers < affectedFloor) return false

	const fraction =
		input.activeUsers <= 0 ? null : input.affectedUsers / input.activeUsers
	const baselineFraction = input.baselineFractionMedian
	if (fraction == null) return false
	if (baselineFraction == null) {
		// Cold start: require a meaningful absolute fraction so a quiet fleet
		// cannot page on the first sample above the volume floor alone.
		return fraction >= minFractionDelta
	}
	return fraction >= baselineFraction + minFractionDelta
}

export function emptyFleetUsersAffectedState(): FleetUsersAffectedState {
	return {
		version: 1,
		status: 'ok',
		consecutiveElevatedWindows: 0,
		consecutiveClearWindows: 0,
		incidentStartedAt: null,
		lastWindowEnd: null,
		lastMetrics: null,
		baselineAffectedMedian: null,
		baselineFractionMedian: null,
		pendingNotify: null,
	}
}

/**
 * Debounced elevate / resolve. Fires after N consecutive elevated windows;
 * resolves after N consecutive clear windows while firing. No repeat elevate
 * while already firing.
 */
export function evaluateFleetUsersAffectedTransition(input: {
	previous: FleetUsersAffectedState | null
	metrics: FleetUsersAffectedWindowMetrics
	baselineAffectedMedian: number | null
	baselineFractionMedian: number | null
	now: Date
	windowsToFire?: number
	windowsToResolve?: number
}): FleetUsersAffectedTransition {
	const windowsToFire =
		input.windowsToFire ?? fleetUsersAffectedConsecutiveWindowsToFire
	const windowsToResolve =
		input.windowsToResolve ?? fleetUsersAffectedConsecutiveWindowsToResolve
	const previous = input.previous ?? emptyFleetUsersAffectedState()
	const elevated = isFleetUsersAffectedElevated({
		affectedUsers: input.metrics.affectedUsers,
		activeUsers: input.metrics.activeUsers,
		baselineAffectedMedian: input.baselineAffectedMedian,
		baselineFractionMedian: input.baselineFractionMedian,
	})
	const base: FleetUsersAffectedState = {
		version: 1,
		status: previous.status,
		consecutiveElevatedWindows: previous.consecutiveElevatedWindows,
		consecutiveClearWindows: previous.consecutiveClearWindows,
		incidentStartedAt: previous.incidentStartedAt,
		lastWindowEnd: input.metrics.windowEnd,
		lastMetrics: input.metrics,
		baselineAffectedMedian: input.baselineAffectedMedian,
		baselineFractionMedian: input.baselineFractionMedian,
		pendingNotify: null,
	}

	if (elevated) {
		const consecutive = previous.consecutiveElevatedWindows + 1
		if (previous.status === 'ok') {
			if (consecutive >= windowsToFire) {
				return {
					action: 'elevate',
					elevated: true,
					resolvedIncidentStartedAt: null,
					next: {
						...base,
						status: 'firing',
						consecutiveElevatedWindows: consecutive,
						consecutiveClearWindows: 0,
						incidentStartedAt: input.now.toISOString(),
						pendingNotify: 'elevate',
					},
				}
			}
			return {
				action: 'none',
				elevated: true,
				resolvedIncidentStartedAt: null,
				next: {
					...base,
					status: 'ok',
					consecutiveElevatedWindows: consecutive,
					consecutiveClearWindows: 0,
					incidentStartedAt: null,
				},
			}
		}
		return {
			action: 'none',
			elevated: true,
			resolvedIncidentStartedAt: null,
			next: {
				...base,
				status: 'firing',
				consecutiveElevatedWindows: consecutive,
				consecutiveClearWindows: 0,
			},
		}
	}

	if (previous.status === 'firing') {
		const consecutive = previous.consecutiveClearWindows + 1
		if (consecutive >= windowsToResolve) {
			return {
				action: 'resolve',
				elevated: false,
				resolvedIncidentStartedAt: previous.incidentStartedAt,
				next: {
					...base,
					status: 'ok',
					consecutiveElevatedWindows: 0,
					consecutiveClearWindows: 0,
					// Keep incidentStartedAt until pending resolve notify clears
					// so same-window retries can still build the resolved email.
					incidentStartedAt: previous.incidentStartedAt,
					pendingNotify: 'resolve',
				},
			}
		}
		return {
			action: 'none',
			elevated: false,
			resolvedIncidentStartedAt: null,
			next: {
				...base,
				status: 'firing',
				consecutiveElevatedWindows: 0,
				consecutiveClearWindows: consecutive,
			},
		}
	}

	return {
		action: 'none',
		elevated: false,
		resolvedIncidentStartedAt: null,
		next: {
			...base,
			status: 'ok',
			consecutiveElevatedWindows: 0,
			consecutiveClearWindows: 0,
			incidentStartedAt: null,
		},
	}
}

export function parseFleetUsersAffectedState(
	value: unknown,
): FleetUsersAffectedState | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (record.version !== 1) return null
	if (record.status !== 'ok' && record.status !== 'firing') return null
	return {
		version: 1,
		status: record.status,
		consecutiveElevatedWindows:
			typeof record.consecutiveElevatedWindows === 'number'
				? Math.max(0, Math.round(record.consecutiveElevatedWindows))
				: 0,
		consecutiveClearWindows:
			typeof record.consecutiveClearWindows === 'number'
				? Math.max(0, Math.round(record.consecutiveClearWindows))
				: 0,
		incidentStartedAt:
			typeof record.incidentStartedAt === 'string'
				? record.incidentStartedAt
				: null,
		lastWindowEnd:
			typeof record.lastWindowEnd === 'string' ? record.lastWindowEnd : null,
		lastMetrics: parseWindowMetrics(record.lastMetrics),
		baselineAffectedMedian:
			typeof record.baselineAffectedMedian === 'number'
				? record.baselineAffectedMedian
				: null,
		baselineFractionMedian:
			typeof record.baselineFractionMedian === 'number'
				? record.baselineFractionMedian
				: null,
		pendingNotify:
			record.pendingNotify === 'elevate' || record.pendingNotify === 'resolve'
				? record.pendingNotify
				: null,
	}
}

/** Clear pendingNotify after a successful elevate/resolve admin dispatch. */
export function clearFleetUsersAffectedPendingNotify(
	state: FleetUsersAffectedState,
): FleetUsersAffectedState {
	if (state.pendingNotify == null) return state
	return {
		...state,
		pendingNotify: null,
		incidentStartedAt:
			state.pendingNotify === 'resolve' ? null : state.incidentStartedAt,
	}
}

function parseWindowMetrics(
	value: unknown,
): FleetUsersAffectedWindowMetrics | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const record = value as Record<string, unknown>
	if (
		typeof record.windowStart !== 'string' ||
		typeof record.windowEnd !== 'string' ||
		typeof record.affectedUsers !== 'number' ||
		typeof record.activeUsers !== 'number'
	) {
		return null
	}
	return {
		windowStart: record.windowStart,
		windowEnd: record.windowEnd,
		affectedUsers: Math.max(0, Math.round(record.affectedUsers)),
		activeUsers: Math.max(0, Math.round(record.activeUsers)),
		fraction:
			record.fraction === null
				? null
				: typeof record.fraction === 'number'
					? record.fraction
					: null,
		packages: Array.isArray(record.packages) ? (record.packages as never) : [],
		byMetric: Array.isArray(record.byMetric) ? (record.byMetric as never) : [],
		dominantPackage:
			record.dominantPackage &&
			typeof record.dominantPackage === 'object' &&
			!Array.isArray(record.dominantPackage)
				? (record.dominantPackage as FleetUsersAffectedWindowMetrics['dominantPackage'])
				: null,
	}
}

export function parseFleetUsersAffectedHistory(
	value: unknown,
): FleetUsersAffectedHistory {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { version: 1, samples: [] }
	}
	const record = value as Record<string, unknown>
	if (record.version !== 1 || !Array.isArray(record.samples)) {
		return { version: 1, samples: [] }
	}
	const samples: FleetUsersAffectedHistory['samples'] = []
	for (const entry of record.samples) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const row = entry as Record<string, unknown>
		if (
			typeof row.windowEnd !== 'string' ||
			typeof row.affectedUsers !== 'number' ||
			typeof row.activeUsers !== 'number'
		) {
			continue
		}
		samples.push({
			windowEnd: row.windowEnd,
			affectedUsers: Math.max(0, Math.round(row.affectedUsers)),
			activeUsers: Math.max(0, Math.round(row.activeUsers)),
			fraction:
				row.fraction === null
					? null
					: typeof row.fraction === 'number'
						? row.fraction
						: null,
		})
	}
	return { version: 1, samples }
}

export function appendFleetUsersAffectedHistory(input: {
	history: FleetUsersAffectedHistory
	windowEnd: string
	affectedUsers: number
	activeUsers: number
	fraction: number | null
	maxSamples?: number
}): FleetUsersAffectedHistory {
	const maxSamples = input.maxSamples ?? fleetUsersAffectedMaxHistorySamples
	const withoutDup = input.history.samples.filter(
		(sample) => sample.windowEnd !== input.windowEnd,
	)
	const samples = [
		...withoutDup,
		{
			windowEnd: input.windowEnd,
			affectedUsers: input.affectedUsers,
			activeUsers: input.activeUsers,
			fraction: input.fraction,
		},
	].slice(-maxSamples)
	return { version: 1, samples }
}

/**
 * Median baseline over history. When `excludeTrailing` is set (the current
 * consecutive elevated streak), those newest samples stay out of the median so
 * a debounce pair cannot raise 2×baseline above the still-hot second window.
 */
export function baselineFromHistory(
	history: FleetUsersAffectedHistory,
	options?: { excludeTrailing?: number },
) {
	const excludeTrailing = Math.max(0, options?.excludeTrailing ?? 0)
	const samples =
		excludeTrailing === 0
			? history.samples
			: history.samples.slice(
					0,
					Math.max(0, history.samples.length - excludeTrailing),
				)
	const affected = samples.map((sample) => sample.affectedUsers)
	const fractions = samples
		.map((sample) => sample.fraction)
		.filter((value): value is number => typeof value === 'number')
	return {
		baselineAffectedMedian: medianOf(affected),
		baselineFractionMedian: medianOf(fractions),
	}
}

export function buildFleetUsersAffectedActorQuery(input: {
	dataset: string
	windowStart: Date
	windowEnd: Date
	outcomeFilter: 'error' | 'any'
}) {
	const metrics = fleetPackageErrorRateMetrics
		.map((metric) => `'${metric}'`)
		.join(', ')
	const outcomeClause =
		input.outcomeFilter === 'error' ? `AND blob4 = 'error'` : ''
	// Distinct actors: blob10 when set, else billing blob1 (legacy / automation
	// defaults). Empty blob10 means Automation — count as one synthetic actor
	// key so automation storms still register without inventing person ids.
	return `
SELECT
	if(blob10 = '', concat('automation:', blob1), blob10) AS actor_id,
	count() AS event_count
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${toAnalyticsDateTime(input.windowStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.windowEnd)}')
	AND blob2 IN (${metrics})
	${outcomeClause}
GROUP BY actor_id
FORMAT JSON
`.trim()
}

export function buildFleetUsersAffectedPackageActorQuery(input: {
	dataset: string
	windowStart: Date
	windowEnd: Date
}) {
	const metrics = fleetPackageErrorRateMetrics
		.map((metric) => `'${metric}'`)
		.join(', ')
	return `
SELECT
	blob3 AS package_id,
	blob2 AS metric,
	if(blob10 = '', concat('automation:', blob1), blob10) AS actor_id
FROM ${input.dataset}
WHERE timestamp >= toDateTime('${toAnalyticsDateTime(input.windowStart)}')
	AND timestamp < toDateTime('${toAnalyticsDateTime(input.windowEnd)}')
	AND blob2 IN (${metrics})
	AND blob4 = 'error'
	AND blob3 != ''
GROUP BY package_id, metric, actor_id
FORMAT JSON
`.trim()
}

export type FleetUsersAffectedPackageActorRow = {
	package_id?: string
	metric?: string
	actor_id?: string
}

export function foldFleetUsersAffectedWindow(input: {
	windowStart: Date
	windowEnd: Date
	affectedActorCount: number
	activeActorCount: number
	packageActorRows: ReadonlyArray<FleetUsersAffectedPackageActorRow>
	packageKodyIds: ReadonlyMap<string, string>
}): FleetUsersAffectedWindowMetrics {
	const actorsByPackage = new Map<string, Set<string>>()
	const actorsByMetric = new Map<string, Set<string>>()
	for (const row of input.packageActorRows) {
		const packageId = row.package_id?.trim() ?? ''
		const actorId = row.actor_id?.trim() ?? ''
		const metric = row.metric?.trim() ?? ''
		if (!packageId || !actorId || !analyticsEngineIdPattern.test(packageId)) {
			continue
		}
		// Metric breakdown does not need a resolved package name; count first so
		// a failed D1 lookup still populates by_metric.
		if (
			(fleetPackageErrorRateMetrics as ReadonlyArray<string>).includes(metric)
		) {
			const metricActors = actorsByMetric.get(metric) ?? new Set<string>()
			metricActors.add(actorId)
			actorsByMetric.set(metric, metricActors)
		}
		const kodyId = input.packageKodyIds.get(packageId)
		if (!kodyId) continue
		const pkgActors = actorsByPackage.get(kodyId) ?? new Set<string>()
		pkgActors.add(actorId)
		actorsByPackage.set(kodyId, pkgActors)
	}
	const affectedUsers = Math.max(0, Math.round(input.affectedActorCount))
	const packages = [...actorsByPackage.entries()]
		.map(([kody_id, actors]) => ({
			kody_id,
			affected_users: actors.size,
			share: affectedUsers === 0 ? 0 : actors.size / affectedUsers,
		}))
		.sort((left, right) => right.affected_users - left.affected_users)
		.slice(0, fleetUsersAffectedMaxNamedPackages)
	const top = packages[0] ?? null
	const dominantPackage =
		top && top.share > 0.5
			? {
					kody_id: top.kody_id,
					affected_users: top.affected_users,
					share: top.share,
				}
			: null
	return {
		windowStart: input.windowStart.toISOString(),
		windowEnd: input.windowEnd.toISOString(),
		affectedUsers,
		activeUsers: Math.max(0, Math.round(input.activeActorCount)),
		fraction:
			input.activeActorCount <= 0
				? null
				: affectedUsers / Math.max(0, Math.round(input.activeActorCount)),
		packages,
		byMetric: fleetPackageErrorRateMetrics
			.map((metric) => ({
				metric,
				affected_users: actorsByMetric.get(metric)?.size ?? 0,
			}))
			.filter((row) => row.affected_users > 0),
		dominantPackage,
	}
}

export async function loadPackageKodyIds(
	db: D1Database,
	packageIds: ReadonlyArray<string>,
) {
	const kodyIds = new Map<string, string>()
	for (const chunk of chunkArray([...packageIds], maxSqlBindingsPerChunk)) {
		if (chunk.length === 0) continue
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT id, kody_id
				FROM saved_packages
				WHERE id IN (${placeholders})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{ id: string; kody_id: string }>()
		for (const row of result.results ?? []) {
			const kodyId = row.kody_id.trim()
			if (!kodyId) continue
			kodyIds.set(row.id, kodyId)
		}
	}
	return kodyIds
}

export type FleetUsersAffectedRefreshResult =
	| {
			status: 'skipped'
			reason: 'missing-analytics-config' | 'query_failed' | 'no_kv' | 'no_db'
	  }
	| {
			status: 'refreshed'
			action: FleetUsersAffectedTransitionAction
			elevated: boolean
			resolvedIncidentStartedAt: string | null
			metrics: FleetUsersAffectedWindowMetrics
			state: FleetUsersAffectedState
	  }

export async function refreshFleetUsersAffected(input: {
	env: FleetUsersAffectedEnv
	now?: Date
}): Promise<FleetUsersAffectedRefreshResult> {
	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const db = input.env.APP_DB
	if (!kv) return { status: 'skipped', reason: 'no_kv' }
	if (!db) return { status: 'skipped', reason: 'no_db' }

	const accountId = input.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = input.env.CLOUDFLARE_API_TOKEN?.trim()
	if (!input.env.USAGE_EVENTS || !accountId || !apiToken) {
		return { status: 'skipped', reason: 'missing-analytics-config' }
	}

	const now = input.now ?? new Date()
	const windowEnd = alignToUtcWindow(now, fleetUsersAffectedWindowMs)
	const windowStart = new Date(windowEnd.getTime() - fleetUsersAffectedWindowMs)
	const dataset = resolveUsageEventsDataset(input.env)
	const baseUrl =
		input.env.CLOUDFLARE_API_BASE_URL?.trim() || 'https://api.cloudflare.com'

	type ActorRow = { actor_id?: string; event_count?: number | string }
	let affectedRows: Array<ActorRow>
	let activeRows: Array<ActorRow>
	try {
		;[affectedRows, activeRows] = await Promise.all([
			queryAnalyticsEngineSql<ActorRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetUsersAffectedActorQuery({
					dataset,
					windowStart,
					windowEnd,
					outcomeFilter: 'error',
				}),
			}),
			queryAnalyticsEngineSql<ActorRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetUsersAffectedActorQuery({
					dataset,
					windowStart,
					windowEnd,
					outcomeFilter: 'any',
				}),
			}),
		])
	} catch (error) {
		console.warn('fleet-users-affected-query-failed', error)
		return { status: 'skipped', reason: 'query_failed' }
	}

	// Ranking / attribution is best-effort: a row-limit or timeout must not
	// suppress elevate/resolve for the distinct-actor detection queries.
	let packageActorRows: Array<FleetUsersAffectedPackageActorRow> = []
	try {
		packageActorRows =
			await queryAnalyticsEngineSql<FleetUsersAffectedPackageActorRow>({
				accountId,
				apiToken,
				baseUrl,
				query: buildFleetUsersAffectedPackageActorQuery({
					dataset,
					windowStart,
					windowEnd,
				}),
			})
	} catch (error) {
		console.warn('fleet-users-affected-package-actors-failed', error)
	}

	const packageIds = [
		...new Set(
			packageActorRows
				.map((row) => row.package_id?.trim() ?? '')
				.filter((id) => id.length > 0),
		),
	]
	let packageKodyIds: Map<string, string>
	try {
		packageKodyIds = await loadPackageKodyIds(db, packageIds)
	} catch (error) {
		console.warn('fleet-users-affected-package-names-failed', error)
		packageKodyIds = new Map()
	}

	const metrics = foldFleetUsersAffectedWindow({
		windowStart,
		windowEnd,
		affectedActorCount: affectedRows.filter((row) => row.actor_id?.trim())
			.length,
		activeActorCount: activeRows.filter((row) => row.actor_id?.trim()).length,
		packageActorRows,
		packageKodyIds,
	})

	const previous = parseFleetUsersAffectedState(
		await kv.get(fleetUsersAffectedKvKey, 'json').catch(() => null),
	)
	const history = parseFleetUsersAffectedHistory(
		await kv.get(fleetUsersAffectedHistoryKvKey, 'json').catch(() => null),
	)

	// Same completed window: do not re-advance counters; replay pending notify.
	if (previous?.lastWindowEnd === metrics.windowEnd) {
		const pending =
			previous.pendingNotify === 'elevate' ||
			previous.pendingNotify === 'resolve'
				? previous.pendingNotify
				: 'none'
		return {
			status: 'refreshed',
			action: pending,
			elevated:
				previous.status === 'firing' || previous.pendingNotify === 'elevate',
			resolvedIncidentStartedAt:
				pending === 'resolve' ? previous.incidentStartedAt : null,
			metrics: previous.lastMetrics ?? metrics,
			state: previous,
		}
	}

	// Baseline excludes the current window (not yet appended) and any trailing
	// samples already counted toward the in-progress elevate debounce.
	const { baselineAffectedMedian, baselineFractionMedian } =
		baselineFromHistory(history, {
			excludeTrailing: previous?.consecutiveElevatedWindows ?? 0,
		})

	const transition = evaluateFleetUsersAffectedTransition({
		previous,
		metrics,
		baselineAffectedMedian,
		baselineFractionMedian,
		now,
	})

	const nextHistory = appendFleetUsersAffectedHistory({
		history,
		windowEnd: metrics.windowEnd,
		affectedUsers: metrics.affectedUsers,
		activeUsers: metrics.activeUsers,
		fraction: metrics.fraction,
	})

	// History before state so a failed history write does not leave counters
	// advanced without the sample that would explain them on retry.
	await kv.put(fleetUsersAffectedHistoryKvKey, JSON.stringify(nextHistory), {
		expirationTtl: stateTtlSeconds,
	})
	await kv.put(fleetUsersAffectedKvKey, JSON.stringify(transition.next), {
		expirationTtl: stateTtlSeconds,
	})

	return {
		status: 'refreshed',
		action: transition.action,
		elevated: transition.elevated,
		resolvedIncidentStartedAt: transition.resolvedIncidentStartedAt,
		metrics,
		state: transition.next,
	}
}

function toAnalyticsDateTime(date: Date) {
	return date.toISOString().slice(0, 19).replace('T', ' ')
}
