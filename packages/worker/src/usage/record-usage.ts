/**
 * Per-user usage metering.
 *
 * One event schema covers every metered chokepoint (execute runs, package
 * export invocations, statically imported package export calls, job runs,
 * workflow runs, realtime websocket sessions, gateway fetches, email sends and
 * receives, unique Dynamic Worker days, observe-only Dynamic Worker
 * invokes, and observe-only Durable Object duration).
 *
 * The write path depends on the environment:
 *
 * - When the Workers Analytics Engine binding (`USAGE_EVENTS`) is present
 *   (production/preview), the event is written **only** to Analytics Engine.
 *   The D1 `usage_rollups` table is then a derived aggregate, recomputed
 *   hourly from Analytics Engine by
 *   `packages/worker/src/usage/aggregate-rollups.ts` — a per-event D1 upsert
 *   would serialize every metered request on D1's single writer.
 * - When `USAGE_EVENTS` is absent (local dev, tests), the event is upserted
 *   directly into `usage_rollups` so local admin pages and tests work without
 *   Analytics Engine access.
 *
 * `recordUsage` never throws and never rejects; metering must not break the
 * paths it observes. In local dev and tests where a binding is missing it
 * degrades to a debug log. See
 * `docs/contributing/architecture/usage-metering.md`.
 *
 * Every recorded event also emits a `kody.usage.{eventType}` trace span (when
 * Workers tracing is available) carrying the user id, entity id, and outcome
 * as attributes. The chokepoints that meter usage are exactly the app-level
 * units worth finding in traces, so this one funnel makes every trace
 * searchable by user and feature without touching the chokepoints themselves.
 */

import * as cloudflareWorkers from 'cloudflare:workers'
import {
	type AutomationSource,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import {
	connectionKeyColumns,
	isConnectionUsageEventType,
} from '#universal/connection-usage.ts'
import {
	creditAttributionMeterFromUsageEventType,
	normalizeCreditAttributionPackageId,
} from '#universal/credit-attribution.ts'
import {
	isCoalescedCountUsageEventType,
	type UsageEventType,
} from '#universal/usage-event-types.ts'
import { stampFirstExecute } from '#worker/identity/activation-stamps.ts'
import { type DynamicWorkerDaySurface } from './dynamic-worker-day-surface.ts'
import { type ExecuteThinGlueClass } from './execute-thin-glue.ts'
import {
	sanitizeUsageErrorName,
	usageErrorNameUnrecorded,
} from './usage-error-name.ts'

export {
	sanitizeUsageErrorName,
	usageErrorNameFromUnknown,
	usageErrorNameMaxLength,
	usageErrorNameUnrecorded,
} from './usage-error-name.ts'

export {
	usageEventTypes,
	type UsageEventType,
} from '#universal/usage-event-types.ts'

// Older local runtimes (and the node test stub) may not expose `tracing`;
// treat it as optional so metering keeps its never-throws contract.
const runtimeTracing: typeof cloudflareWorkers.tracing | undefined = (
	cloudflareWorkers as Partial<typeof cloudflareWorkers>
).tracing

/**
 * `caught` is only written for `package_static_call`: the callee threw, but the
 * run still succeeded (caller handled it). Fleet error-rate math counts only
 * `error`. Historical rows without `caught` stay valid as `error`/`success`.
 */
export type UsageOutcome = 'success' | 'error' | 'caught'

export type UsageEvent = {
	/** Owning user. Required: every usage event is scoped to one user. */
	userId: string
	eventType: UsageEventType
	/**
	 * Identifier of the metered entity when one exists (package id, job id,
	 * workflow run id, email message id, fetch host).
	 */
	entityId?: string | null
	/** Wall-clock duration of the metered unit, in milliseconds. */
	durationMs?: number | null
	/** CPU time in milliseconds, only when the platform exposes it. */
	cpuMs?: number | null
	/** Bytes transferred/stored when meaningful (fetch bodies, email size). */
	bytes?: number | null
	/**
	 * How many metered units this write represents. Defaults to 1. Coalesced
	 * `durable_object_gb_seconds` bursts send one Analytics Engine point with
	 * the summed duration and this count in `doubles[2]`.
	 */
	eventCount?: number
	outcome: UsageOutcome
	/** ISO 8601 timestamp. Defaults to the time of recording. */
	timestamp?: string
	/**
	 * Closed surface tag for `dynamic_worker_day` (and optionally other
	 * events). Written to Analytics Engine blob6. Empty when unset.
	 */
	surface?: DynamicWorkerDaySurface | null
	/**
	 * Host-side execute thin/glue class. Written to Analytics Engine blob7
	 * on `execute` events. Never used for billing and not shown to agents.
	 */
	executeShape?: ExecuteThinGlueClass | null
	/**
	 * Billing-aligned Dynamic Worker reuse. Written to Analytics Engine
	 * blob8 on `dynamic_worker_invoke`. `miss` when this worker id was
	 * first claimed today; `hit` on later claims the same UTC day.
	 */
	cacheReuse?: DynamicWorkerCacheReuse | null
	/**
	 * Character length of the hashable module-graph text used for the
	 * Dynamic Worker id. Written to Analytics Engine double4. Number only.
	 */
	codeChars?: number | null
	/**
	 * Character length of a stable JSON serialization of evaluate
	 * `params`. 0 when `params` is null, undefined, a non-object, or
	 * empty `{}`. Written to Analytics Engine double5. Number only —
	 * never the JSON.
	 */
	paramsChars?: number | null
	/**
	 * Saved package id when the billable unit is known to belong to one
	 * package. Written to Analytics Engine blob9. Empty means Ad hoc
	 * (direct execute or unattributed). Never guess.
	 */
	packageId?: string | null
	/**
	 * Person who triggered the metered unit. Empty for Automation. When unset
	 * at write time, defaults to `userId` (org billing id) for backward
	 * compatibility with P3 actor backfill.
	 */
	actorUserId?: string | null
	/**
	 * Closed automation source for Analytics Engine blob11. Empty for
	 * interactive runs and for platform `event` automations.
	 */
	automationSource?: string | null
	/**
	 * Credential the unit came through, from {@link usageConnectionKey}.
	 * Analytics Engine blob12. Empty when unknown (pre-attribution events,
	 * call sites without a request context).
	 */
	connectionKey?: string | null
	/**
	 * Short error name or code for failure outcomes (for example
	 * `credential_need_undeclared`). Analytics Engine blob13. Empty on
	 * success, on `caught` when no name was reported, and on historical
	 * rows written before this dimension existed. Never a free-form message.
	 */
	errorName?: string | null
}

export const dynamicWorkerCacheReuses = ['hit', 'miss'] as const
export type DynamicWorkerCacheReuse = (typeof dynamicWorkerCacheReuses)[number]

/** Analytics Engine blob positions for `USAGE_EVENTS` data points. */
export const usageEventBlobIndexes = {
	userId: 0,
	eventType: 1,
	entityId: 2,
	outcome: 3,
	timestamp: 4,
	surface: 5,
	executeShape: 6,
	cacheReuse: 7,
	packageId: 8,
	actorUserId: 9,
	automationSource: 10,
	connectionKey: 11,
	errorName: 12,
} as const

export function automationSourceForAnalytics(
	source: AutomationSource | undefined,
): string {
	if (source === 'webhook' || source === 'schedule' || source === 'email') {
		return source
	}
	return ''
}

/**
 * `<credential kind>:<holder person id>:<credential id>` for the credential
 * a request came through. The holder is the acting person (empty for
 * Automation), so one shared OAuth client id (the CLI) still splits by person
 * and team readers can filter to their own connections. The credential id is
 * last because OAuth client ids are URLs that contain `:`.
 */
export function usageConnectionKey(
	request: RequestContext | null | undefined,
): string {
	if (!request) return ''
	const holder =
		request.attribution.kind === 'automation'
			? ''
			: (request.actor?.userId ?? request.attribution.userId ?? '')
	return `${request.credential.kind}:${holder}:${request.credential.id ?? ''}`
}

/**
 * Connection-key-only attribution for events whose actor blobs must keep
 * their current meaning (`dynamic_worker_day` feeds budget actor weights).
 */
export function usageConnectionFieldsFromRequest(
	request: RequestContext | null | undefined,
): Pick<UsageEvent, 'connectionKey'> {
	const connectionKey = usageConnectionKey(request)
	return connectionKey ? { connectionKey } : {}
}

/** Map a request context to usage attribution blobs when available. */
export function usageAttributionFieldsFromRequest(
	request: RequestContext | null | undefined,
): Pick<UsageEvent, 'actorUserId' | 'automationSource' | 'connectionKey'> {
	if (!request) return {}
	const connectionKey = usageConnectionKey(request)
	if (request.attribution.kind === 'automation') {
		return {
			actorUserId: '',
			automationSource: automationSourceForAnalytics(
				request.attribution.source,
			),
			connectionKey,
		}
	}
	const actorUserId =
		request.actor?.userId ?? request.attribution.userId ?? undefined
	return {
		...(actorUserId ? { actorUserId } : {}),
		automationSource: '',
		connectionKey,
	}
}

function resolvedUsageAttributionBlobs(
	event: Pick<UsageEvent, 'userId' | 'actorUserId' | 'automationSource'>,
): [string, string] {
	const automationSource = event.automationSource?.trim() ?? ''
	const actorTrimmed = event.actorUserId?.trim()
	if (actorTrimmed) {
		return [actorTrimmed, automationSource]
	}
	if (automationSource) {
		return ['', automationSource]
	}
	return [event.userId, '']
}

export const usageEventDoubleIndexes = {
	durationMs: 0,
	cpuMs: 1,
	bytesOrCoalescedCount: 2,
	codeChars: 3,
	paramsChars: 4,
} as const

export function usageEventBlobs(
	event: Pick<
		UsageEvent,
		| 'userId'
		| 'eventType'
		| 'entityId'
		| 'outcome'
		| 'surface'
		| 'executeShape'
		| 'cacheReuse'
		| 'packageId'
		| 'actorUserId'
		| 'automationSource'
		| 'connectionKey'
		| 'errorName'
	>,
	timestamp: string,
): [
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
] {
	const [actorUserId, automationSource] = resolvedUsageAttributionBlobs(event)
	return [
		event.userId,
		event.eventType,
		event.entityId ?? '',
		event.outcome,
		timestamp,
		event.surface ?? '',
		event.executeShape ?? '',
		event.cacheReuse ?? '',
		event.packageId?.trim() || '',
		actorUserId,
		automationSource,
		event.connectionKey?.trim() || '',
		event.outcome === 'success'
			? usageErrorNameUnrecorded
			: sanitizeUsageErrorName(event.errorName),
	]
}

export type UsageEnv = {
	USAGE_EVENTS?: AnalyticsEngineDataset
	APP_DB?: D1Database
}

const usageRollupUpsertStatement = `
INSERT INTO usage_rollups (
	user_id, metric, month,
	event_count, error_count, caught_count,
	total_duration_ms, total_cpu_ms, total_bytes,
	updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
ON CONFLICT (user_id, metric, month) DO UPDATE SET
	event_count = event_count + excluded.event_count,
	error_count = error_count + excluded.error_count,
	caught_count = caught_count + excluded.caught_count,
	total_duration_ms = total_duration_ms + excluded.total_duration_ms,
	total_cpu_ms = total_cpu_ms + excluded.total_cpu_ms,
	total_bytes = total_bytes + excluded.total_bytes,
	updated_at = excluded.updated_at
`.trim()

const usageAttributionDailyUpsertStatement = `
INSERT INTO usage_attribution_daily (
	user_id, day, package_id, meter, units, updated_at,
	actor_user_id, automation_source
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT (user_id, day, package_id, meter) DO UPDATE SET
	units = units + excluded.units,
	updated_at = excluded.updated_at,
	actor_user_id = excluded.actor_user_id,
	automation_source = excluded.automation_source
`.trim()

const usageConnectionDailyUpsertStatement = `
INSERT INTO usage_connection_daily (
	user_id, day, credential_kind, holder_user_id, credential_id,
	package_id, event_type, units, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT (
	user_id, day, credential_kind, holder_user_id, credential_id,
	package_id, event_type
) DO UPDATE SET
	units = units + excluded.units,
	updated_at = excluded.updated_at
`.trim()

/**
 * Record one usage event.
 *
 * With `USAGE_EVENTS` bound this is a single non-blocking `writeDataPoint`
 * call; the D1 rollup is derived later by the hourly aggregation cron.
 * Without it (local dev, tests) the event is upserted into `usage_rollups`
 * directly.
 *
 * Guarantees:
 * - Never throws and never rejects: failures are logged at debug level.
 * - Each sink degrades independently when its binding is unavailable.
 *
 * Callers should `await` it (cheap: one `writeDataPoint`, or one D1 upsert in
 * local dev) or hand the promise to `ctx.waitUntil(...)` inside Durable
 * Objects. Successful `execute` events still stamp `users.first_execute_at`;
 * pass `waitUntil` to keep that D1 write off the critical path.
 */
export async function recordUsage(
	env: UsageEnv,
	event: UsageEvent,
	options?: { waitUntil?: (promise: Promise<unknown>) => void },
): Promise<void> {
	try {
		if (!event.userId) {
			console.debug('usage-event-skipped', 'missing userId', event.eventType)
			return
		}
		emitUsageSpan(event)
		const timestamp = event.timestamp ?? new Date().toISOString()
		if (
			event.eventType === 'execute' &&
			event.outcome === 'success' &&
			env.APP_DB
		) {
			const stamp = stampFirstExecute(
				env.APP_DB,
				{
					stableUserId: event.userId,
					at: timestamp,
				},
				env,
			).catch((error: unknown) => {
				console.warn('activation-stamp-execute-failed', error)
			})
			if (options?.waitUntil) {
				options.waitUntil(stamp)
			} else {
				await stamp
			}
		}
		if (env.USAGE_EVENTS) {
			writeUsageDataPoint(env, event, timestamp)
			return
		}
		console.debug('usage-event-local', JSON.stringify({ ...event, timestamp }))
		await writeUsageRollup(env, event, timestamp)
	} catch (error) {
		console.warn('usage-event-record-failed', error)
	}
}

/**
 * Emit a marker span for one usage event, nested under whatever platform span
 * is active in the current async context (HTTP handler, DO invocation, ...).
 * When the invocation is not sampled, `enterSpan` still runs the callback but
 * records nothing.
 */
function emitUsageSpan(event: UsageEvent) {
	if (!runtimeTracing?.enterSpan) return
	try {
		runtimeTracing.enterSpan(`kody.usage.${event.eventType}`, (span) => {
			span.setAttribute('kody.user_id', event.userId)
			span.setAttribute('kody.event_type', event.eventType)
			span.setAttribute('kody.outcome', event.outcome)
			if (event.entityId) span.setAttribute('kody.entity_id', event.entityId)
			if (event.durationMs != null) {
				span.setAttribute('kody.duration_ms', event.durationMs)
			}
			if (event.bytes != null) span.setAttribute('kody.bytes', event.bytes)
			if (event.surface) span.setAttribute('kody.surface', event.surface)
			if (event.executeShape) {
				span.setAttribute('kody.execute_shape', event.executeShape)
			}
			if (event.cacheReuse) {
				span.setAttribute('kody.cache_reuse', event.cacheReuse)
			}
			if (event.codeChars != null) {
				span.setAttribute('kody.code_chars', event.codeChars)
			}
			if (event.paramsChars != null) {
				span.setAttribute('kody.params_chars', event.paramsChars)
			}
			if (event.packageId) {
				span.setAttribute('kody.package_id', event.packageId)
			}
			const [actorUserId, automationSource] =
				resolvedUsageAttributionBlobs(event)
			if (actorUserId) {
				span.setAttribute('kody.actor_user_id', actorUserId)
			}
			if (automationSource) {
				span.setAttribute('kody.automation_source', automationSource)
			}
			if (event.connectionKey) {
				span.setAttribute('kody.connection_key', event.connectionKey)
			}
			const errorName = sanitizeUsageErrorName(event.errorName)
			if (errorName) {
				span.setAttribute('kody.error_name', errorName)
			}
		})
	} catch (error) {
		console.debug('usage-span-failed', error)
	}
}

function writeUsageDataPoint(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
) {
	if (!env.USAGE_EVENTS) return
	try {
		env.USAGE_EVENTS.writeDataPoint({
			indexes: [event.userId],
			blobs: usageEventBlobs(event, timestamp),
			doubles: [
				event.durationMs ?? 0,
				event.cpuMs ?? 0,
				isCoalescedCountUsageEventType(event.eventType)
					? usageEventCount(event)
					: (event.bytes ?? 0),
				event.codeChars ?? 0,
				event.paramsChars ?? 0,
			],
		})
	} catch (error) {
		console.warn('usage-event-analytics-failed', error)
	}
}

async function writeUsageRollup(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
) {
	if (!env.APP_DB) {
		console.debug('usage-rollup-skipped', 'missing APP_DB binding')
		return
	}
	try {
		const eventCount = usageEventCount(event)
		await env.APP_DB.prepare(usageRollupUpsertStatement)
			.bind(
				event.userId,
				event.eventType,
				timestamp.slice(0, 7),
				eventCount,
				event.outcome === 'error' ? eventCount : 0,
				event.outcome === 'caught' ? eventCount : 0,
				Math.round(event.durationMs ?? 0),
				Math.round(event.cpuMs ?? 0),
				Math.round(event.bytes ?? 0),
				timestamp,
			)
			.run()
		await writeUsageAttributionDaily(env, event, timestamp, eventCount)
		await writeUsageConnectionDaily(env, event, timestamp, eventCount)
	} catch (error) {
		console.warn('usage-rollup-failed', error)
	}
}

/**
 * Local/dev path: stamp billable units into `usage_attribution_daily` so
 * `/account/usage` can show Where it went without Analytics Engine.
 * Production recomputes this table from AE hourly.
 */
async function writeUsageAttributionDaily(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
	eventCount: number,
) {
	if (!env.APP_DB) return
	const meter = creditAttributionMeterFromUsageEventType(event.eventType)
	if (!meter) return
	const [actorUserId, automationSource] = resolvedUsageAttributionBlobs(event)
	try {
		await env.APP_DB.prepare(usageAttributionDailyUpsertStatement)
			.bind(
				event.userId,
				timestamp.slice(0, 'YYYY-MM-DD'.length),
				normalizeCreditAttributionPackageId(event.packageId),
				meter,
				eventCount,
				timestamp,
				actorUserId,
				automationSource,
			)
			.run()
	} catch (error) {
		console.warn('usage-attribution-daily-failed', error)
	}
}

/**
 * Local/dev path: add one event's units to its `usage_connection_daily` row
 * so the Connections page shows usage without Analytics Engine. Production
 * recomputes this table from AE hourly (`connection-usage-rollup.ts`).
 */
async function writeUsageConnectionDaily(
	env: UsageEnv,
	event: UsageEvent,
	timestamp: string,
	eventCount: number,
) {
	if (!env.APP_DB || !isConnectionUsageEventType(event.eventType)) return
	const columns = connectionKeyColumns(event.connectionKey)
	try {
		await env.APP_DB.prepare(usageConnectionDailyUpsertStatement)
			.bind(
				event.userId,
				timestamp.slice(0, 'YYYY-MM-DD'.length),
				columns.credential_kind,
				columns.holder_user_id,
				columns.credential_id,
				event.packageId?.trim() || '',
				event.eventType,
				eventCount,
				timestamp,
			)
			.run()
	} catch (error) {
		console.warn('usage-connection-daily-failed', error)
	}
}

function usageEventCount(event: UsageEvent) {
	const count = event.eventCount
	if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) {
		return 1
	}
	return Math.trunc(count)
}
