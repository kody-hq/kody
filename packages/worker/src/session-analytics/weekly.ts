import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import type { SessionStuckKind } from '#universal/session-analytics.ts'
import { loadStuckPatterns } from './insights.ts'
import { sweepSessionAnalytics } from './store.ts'

export const sessionStuckPatternCrossedTopic = 'session.stuck_pattern.crossed'
export const sessionCategoryMergedTopic = 'session.category.merged'

const sessionAnalyticsEventActorTokenId = 'internal:session-analytics-events'
const weeklyWindowDays = 7

/** Metadata only: no user, org, package, or session identity. */
export type SessionStuckPatternCrossedEvent = {
	event: typeof sessionStuckPatternCrossedTopic
	category: { id: string; name: string }
	stuck_kind: SessionStuckKind
	stuck_tool: string
	sessions: number
	orgs: number
	/** Share of the category's sessions that ended stuck this way, 0 to 1. */
	share: number
	window: { start: string; end: string; days: number }
	observed_at: string
}

export type SessionCategoryMergedEvent = {
	event: typeof sessionCategoryMergedTopic
	from: { id: string; name: string }
	into: { id: string; name: string }
	observed_at: string
}

type EventEnv = Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'>

async function dispatch(
	env: EventEnv,
	event: SessionStuckPatternCrossedEvent | SessionCategoryMergedEvent,
	key: string,
) {
	try {
		await dispatchAdminPackageSubscriptionEvent({
			env,
			baseUrl: getAppBaseUrl({ env }),
			topic: event.event,
			getParams: () => event as Record<string, unknown>,
			source: 'session-analytics',
			buildIdempotencyKey: (savedPackage) =>
				`${event.event}:${key}:${savedPackage.id}`,
			actorTokenId: sessionAnalyticsEventActorTokenId,
		})
	} catch (error) {
		console.warn('session-analytics-event-dispatch-failed', {
			topic: event.event,
			error: String(error),
		})
	}
}

/** Words reduced to a comparable form: order, plurals, and "-ing" ignored. */
export function categoryMergeKey(name: string) {
	return name
		.split(' ')
		.map((word) => {
			const base = word.replace(/ing$/, '')
			// "process" and "access" end in a double s that is not a plural.
			return base.endsWith('ss') ? base : base.replace(/(es|e|s)$/, '')
		})
		.sort()
		.join(' ')
}

/**
 * Merge categories whose names differ only by word order or word endings
 * into the oldest one. Count rows keep their category id and are resolved
 * through `merged_into` when read.
 */
export async function mergeNearDuplicateCategories(db: D1Database) {
	const rows = await db
		.prepare(
			`SELECT id, name FROM session_analytics_categories
			 WHERE status = 'active' ORDER BY created_at, name`,
		)
		.all<{ id: string; name: string }>()
	const keepers = new Map<string, { id: string; name: string }>()
	const merges: Array<{
		from: { id: string; name: string }
		into: { id: string; name: string }
	}> = []
	for (const row of rows.results) {
		const key = categoryMergeKey(row.name)
		const keeper = keepers.get(key)
		if (!keeper) {
			keepers.set(key, row)
			continue
		}
		merges.push({ from: row, into: keeper })
	}
	for (const merge of merges) {
		await db.batch([
			db
				.prepare(
					`UPDATE session_analytics_categories
					 SET status = 'merged', merged_into = ? WHERE id = ?`,
				)
				.bind(merge.into.id, merge.from.id),
			db
				.prepare(
					`UPDATE session_analytics_categories SET merged_into = ? WHERE merged_into = ?`,
				)
				.bind(merge.into.id, merge.from.id),
			db
				.prepare(
					`UPDATE session_analytics_open_sessions SET category_id = ? WHERE category_id = ?`,
				)
				.bind(merge.into.id, merge.from.id),
		])
	}
	return merges
}

function dayKey(date: Date) {
	return date.toISOString().slice(0, 10)
}

/**
 * Weekly: merge near-duplicate categories, then emit one event per stuck
 * pattern over the minimum in the seven days ending yesterday.
 */
export async function runWeeklySessionAnalytics(input: {
	env: EventEnv
	now: Date
}) {
	const db = input.env.APP_DB
	const observedAt = input.now.toISOString()
	const merges = await mergeNearDuplicateCategories(db)
	for (const merge of merges) {
		await dispatch(
			input.env,
			{
				event: sessionCategoryMergedTopic,
				from: merge.from,
				into: merge.into,
				observed_at: observedAt,
			},
			merge.from.id,
		)
	}
	// A session is counted on the day of its last call but written when it
	// closes, up to an idle timeout later. The window ends a day back so every
	// day in it is final and each count row lands in exactly one weekly window.
	const dayMs = 24 * 60 * 60 * 1000
	const end = dayKey(new Date(input.now.getTime() - dayMs))
	const start = dayKey(
		new Date(input.now.getTime() - (weeklyWindowDays + 1) * dayMs),
	)
	const patterns = await loadStuckPatterns(db, { since: start, until: end })
	for (const pattern of patterns) {
		await dispatch(
			input.env,
			{
				event: sessionStuckPatternCrossedTopic,
				category: { id: pattern.categoryId, name: pattern.categoryName },
				stuck_kind: pattern.stuckKind,
				stuck_tool: pattern.stuckTool,
				sessions: pattern.sessions,
				orgs: pattern.orgs,
				share: Math.round(pattern.share * 1000) / 1000,
				window: { start, end, days: weeklyWindowDays },
				observed_at: observedAt,
			},
			`${end}:${pattern.categoryId}:${pattern.stuckKind}:${pattern.stuckTool}`,
		)
	}
	return { merged: merges.length, patterns: patterns.length }
}

/**
 * Hourly upkeep: close idle sessions and drop rows past retention. The
 * weekly pass runs in the first hour of each UTC Monday.
 */
export async function runSessionAnalyticsMaintenance(input: {
	env: EventEnv
	now: Date
}) {
	const swept = await sweepSessionAnalytics(input.env.APP_DB, input.now)
	const weekly =
		input.now.getUTCDay() === 1 && input.now.getUTCHours() === 0
			? await runWeeklySessionAnalytics(input)
			: null
	return { ...swept, weekly }
}
