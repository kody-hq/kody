import {
	sessionInsightsMinOrgs,
	sessionInsightsMinSessions,
	sessionOutcomes,
	sessionStuckKinds,
	type SessionInsightsEntry,
	type SessionInsightsView,
	type SessionOutcome,
	type SessionStuckKind,
} from '#universal/session-analytics.ts'

export const sessionInsightsWindowDays = 30

function dayKey(now: Date, daysAgo: number) {
	return new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10)
}

function parseOutcome(value: string): SessionOutcome {
	return sessionOutcomes.find((outcome) => outcome === value) ?? 'unknown'
}

function parseStuckKind(value: string): SessionStuckKind | null {
	return sessionStuckKinds.find((kind) => kind === value) ?? null
}

/** `user_id` narrows to one member. Without it the whole org is summed. */
export type SessionInsightsOwner = { orgId: string; userId?: string }

function ownerWhere(owner: SessionInsightsOwner) {
	return owner.userId
		? { sql: 'org_id = ? AND user_id = ?', binds: [owner.orgId, owner.userId] }
		: { sql: 'org_id = ?', binds: [owner.orgId] }
}

type EntryRow = {
	category_id: string
	category_name: string | null
	outcome: string
	stuck_kind: string
	stuck_tool: string
	sessions: number
	calls: number
	errors: number
}

function toEntry(row: EntryRow): SessionInsightsEntry {
	return {
		categoryId: row.category_id,
		categoryName: row.category_name ?? 'uncategorized',
		outcome: parseOutcome(row.outcome),
		stuckKind: parseStuckKind(row.stuck_kind),
		stuckTool: row.stuck_tool || null,
		sessions: row.sessions,
		calls: row.calls,
		errors: row.errors,
	}
}

type SummaryRow = {
	sessions: number | null
	linked_sessions: number | null
	ended_without_errors: number | null
	stuck: number | null
	recovered: number | null
	nudged_sessions: number | null
	calls: number | null
	errors: number | null
}

const summarySelect = `
	SUM(sessions) AS sessions,
	SUM(linked_sessions) AS linked_sessions,
	SUM(CASE WHEN outcome IN ('succeeded', 'recovered') THEN sessions ELSE 0 END) AS ended_without_errors,
	SUM(CASE WHEN outcome = 'stuck' THEN sessions ELSE 0 END) AS stuck,
	SUM(CASE WHEN outcome = 'recovered' THEN sessions ELSE 0 END) AS recovered,
	SUM(nudged_sessions) AS nudged_sessions,
	SUM(calls) AS calls,
	SUM(errors) AS errors`

function toSummary(row: SummaryRow | null) {
	return {
		sessions: row?.sessions ?? 0,
		linkedSessions: row?.linked_sessions ?? 0,
		endedWithoutErrors: row?.ended_without_errors ?? 0,
		stuck: row?.stuck ?? 0,
		recovered: row?.recovered ?? 0,
		nudgedSessions: row?.nudged_sessions ?? 0,
		calls: row?.calls ?? 0,
		errors: row?.errors ?? 0,
	}
}

/** Insights for one member or one org: their own data, no minimum counts. */
export async function loadSessionInsights(
	db: D1Database,
	input: { owner: SessionInsightsOwner; now: Date },
): Promise<SessionInsightsView> {
	const where = ownerWhere(input.owner)
	const since = dayKey(input.now, sessionInsightsWindowDays)
	const [summary, entries, clients] = await db.batch([
		db
			.prepare(
				`SELECT ${summarySelect} FROM session_analytics_counts
				 WHERE ${where.sql} AND day >= ?`,
			)
			.bind(...where.binds, since),
		db
			.prepare(
				`SELECT c.category_id, cat.name AS category_name, c.outcome,
					c.stuck_kind, c.stuck_tool, SUM(c.sessions) AS sessions,
					SUM(c.calls) AS calls, SUM(c.errors) AS errors
				 FROM session_analytics_counts c
				 LEFT JOIN session_analytics_categories cat ON cat.id = c.category_id
				 WHERE ${where.sql.replaceAll('org_id', 'c.org_id').replaceAll('user_id', 'c.user_id')} AND c.day >= ?
				 GROUP BY c.category_id, c.outcome, c.stuck_kind, c.stuck_tool
				 ORDER BY sessions DESC, cat.name LIMIT 200`,
			)
			.bind(...where.binds, since),
		db
			.prepare(
				`SELECT client_name, SUM(sessions) AS sessions,
					SUM(CASE WHEN outcome IN ('succeeded', 'recovered') THEN sessions ELSE 0 END) AS ended_without_errors,
					SUM(CASE WHEN outcome = 'stuck' THEN sessions ELSE 0 END) AS stuck
				 FROM session_analytics_counts
				 WHERE ${where.sql} AND day >= ?
				 GROUP BY client_name ORDER BY sessions DESC LIMIT 20`,
			)
			.bind(...where.binds, since),
	])
	return {
		windowDays: sessionInsightsWindowDays,
		summary: toSummary((summary?.results[0] as SummaryRow | undefined) ?? null),
		entries: ((entries?.results ?? []) as Array<EntryRow>).map(toEntry),
		clients: (
			(clients?.results ?? []) as Array<{
				client_name: string
				sessions: number
				ended_without_errors: number
				stuck: number
			}>
		).map((row) => ({
			clientName: row.client_name,
			sessions: row.sessions,
			endedWithoutErrors: row.ended_without_errors,
			stuck: row.stuck,
		})),
	}
}

export type SessionInsightsEntryKey = {
	categoryId: string
	outcome: SessionOutcome
	stuckKind: SessionStuckKind | null
	stuckTool: string | null
}

/**
 * Delete one entry, or everything, for a member or an org. Deleting is the
 * only change anyone can make to an insight: there is no update path.
 */
export async function deleteSessionInsights(
	db: D1Database,
	input: { owner: SessionInsightsOwner; entry?: SessionInsightsEntryKey },
): Promise<{ deletedRows: number }> {
	const where = ownerWhere(input.owner)
	if (!input.entry) {
		const results = await db.batch(
			[
				'session_analytics_counts',
				'session_analytics_package_counts',
				'session_analytics_links',
				'session_analytics_open_sessions',
			].map((table) =>
				db
					.prepare(`DELETE FROM ${table} WHERE ${where.sql}`)
					.bind(...where.binds),
			),
		)
		return { deletedRows: results[0]?.meta.changes ?? 0 }
	}
	const stuckKind = input.entry.stuckKind ?? ''
	const results = await db.batch([
		db
			.prepare(
				`DELETE FROM session_analytics_counts
				 WHERE ${where.sql} AND category_id = ? AND outcome = ?
				 AND stuck_kind = ? AND stuck_tool = ?`,
			)
			.bind(
				...where.binds,
				input.entry.categoryId,
				input.entry.outcome,
				stuckKind,
				input.entry.stuckTool ?? '',
			),
		db
			.prepare(
				`DELETE FROM session_analytics_package_counts
				 WHERE ${where.sql} AND category_id = ? AND outcome = ?
				 AND stuck_kind = ? AND stuck_tool = ?`,
			)
			.bind(
				...where.binds,
				input.entry.categoryId,
				input.entry.outcome,
				stuckKind,
				input.entry.stuckTool ?? '',
			),
	])
	return { deletedRows: results[0]?.meta.changes ?? 0 }
}

/** A cross-org cell is shown only over both minimums. */
export function meetsCrossOrgMinimum(cell: { sessions: number; orgs: number }) {
	return (
		cell.sessions >= sessionInsightsMinSessions &&
		cell.orgs >= sessionInsightsMinOrgs
	)
}

export type AdminSessionPattern = {
	categoryId: string
	categoryName: string
	stuckKind: SessionStuckKind
	stuckTool: string
	sessions: number
	orgs: number
	/** Share of the category's sessions that ended stuck this way. */
	share: number
	fixedOn: string | null
	before: number | null
	after: number | null
}

export type AdminSessionInsights = {
	windowDays: number
	optedInOrgs: number
	/** Null while the totals are under the cross-org minimum. */
	summary: SessionInsightsView['summary'] | null
	categories: Array<{
		id: string
		name: string
		status: string
		sessions: number | null
	}>
	patterns: Array<AdminSessionPattern>
	clients: SessionInsightsView['clients']
	labelChecks: {
		labeled: number
		reused: number
		proposedPasses: number
		proposals: number
		rejectedPrecheck: number
		rejectedJudge: number
		accepted: number
		failedThreeAttempts: number
		modelFailed: number
		/** Rejected proposals over all proposals. */
		rejectionRate: number | null
		/** Labeling passes that needed a new name and failed all attempts. */
		threeAttemptFailureRate: number | null
	}
}

type PatternRow = {
	category_id: string
	category_name: string | null
	stuck_kind: string
	stuck_tool: string
	sessions: number
	orgs: number
	category_sessions: number
}

/** Stuck patterns over the minimum, with merged categories resolved. */
export async function loadStuckPatterns(
	db: D1Database,
	input: { since: string; until?: string },
) {
	const until = input.until ?? '9999-12-31'
	const rows = await db
		.prepare(
			`WITH resolved AS (
				SELECT COALESCE(cat.merged_into, c.category_id) AS category_id,
					c.org_id, c.outcome, c.stuck_kind, c.stuck_tool, c.sessions
				FROM session_analytics_counts c
				LEFT JOIN session_analytics_categories cat ON cat.id = c.category_id
				WHERE c.day >= ? AND c.day < ?
			), totals AS (
				SELECT category_id, SUM(sessions) AS category_sessions
				FROM resolved GROUP BY category_id
			)
			SELECT r.category_id, name.name AS category_name, r.stuck_kind,
				r.stuck_tool, SUM(r.sessions) AS sessions,
				COUNT(DISTINCT r.org_id) AS orgs, t.category_sessions
			FROM resolved r
			JOIN totals t ON t.category_id = r.category_id
			LEFT JOIN session_analytics_categories name ON name.id = r.category_id
			WHERE r.outcome = 'stuck' AND r.stuck_kind != ''
			GROUP BY r.category_id, r.stuck_kind, r.stuck_tool
			HAVING SUM(r.sessions) >= ? AND COUNT(DISTINCT r.org_id) >= ?
			ORDER BY sessions DESC LIMIT 50`,
		)
		.bind(
			input.since,
			until,
			sessionInsightsMinSessions,
			sessionInsightsMinOrgs,
		)
		.all<PatternRow>()
	return rows.results.flatMap((row) => {
		const stuckKind = parseStuckKind(row.stuck_kind)
		if (!stuckKind) return []
		return [
			{
				categoryId: row.category_id,
				categoryName: row.category_name ?? 'uncategorized',
				stuckKind,
				stuckTool: row.stuck_tool,
				sessions: row.sessions,
				orgs: row.orgs,
				share:
					row.category_sessions > 0 ? row.sessions / row.category_sessions : 0,
			},
		]
	})
}

/**
 * Share of a category's sessions that ended stuck on one pattern in a window,
 * merged categories included. Null when the category's window is under the
 * cross-org minimum, so a thin window never shows a number.
 */
async function stuckShareBetween(
	db: D1Database,
	pattern: { categoryId: string; stuckKind: string; stuckTool: string },
	since: string,
	until: string,
) {
	const row = await db
		.prepare(
			`SELECT SUM(c.sessions) AS sessions, COUNT(DISTINCT c.org_id) AS orgs,
				SUM(CASE WHEN c.outcome = 'stuck' AND c.stuck_kind = ? AND c.stuck_tool = ?
					THEN c.sessions ELSE 0 END) AS stuck
			 FROM session_analytics_counts c
			 LEFT JOIN session_analytics_categories cat ON cat.id = c.category_id
			 WHERE COALESCE(cat.merged_into, c.category_id) = ?
			 AND c.day >= ? AND c.day < ?`,
		)
		.bind(
			pattern.stuckKind,
			pattern.stuckTool,
			pattern.categoryId,
			since,
			until,
		)
		.first<{ sessions: number | null; orgs: number; stuck: number | null }>()
	const sessions = row?.sessions ?? 0
	if (!meetsCrossOrgMinimum({ sessions, orgs: row?.orgs ?? 0 })) return null
	return (row?.stuck ?? 0) / sessions
}

function shiftDay(day: string, days: number) {
	return new Date(Date.parse(`${day}T00:00:00Z`) + days * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10)
}

/** The Kody staff view: every opted-in org combined, minimum counts applied. */
export async function loadAdminSessionInsights(
	db: D1Database,
	now: Date,
): Promise<AdminSessionInsights> {
	const since = dayKey(now, sessionInsightsWindowDays)
	const [orgs, summary, categories, clients, labels, fixes] = await db.batch([
		db.prepare(
			`SELECT COUNT(*) AS n FROM orgs WHERE session_analytics = 'enabled' AND deleted_at IS NULL`,
		),
		db
			.prepare(
				`SELECT ${summarySelect}, COUNT(DISTINCT org_id) AS orgs
				 FROM session_analytics_counts WHERE day >= ?`,
			)
			.bind(since),
		db
			.prepare(
				`SELECT cat.id, cat.name, cat.status,
					COALESCE(SUM(c.sessions), 0) AS sessions,
					COUNT(DISTINCT c.org_id) AS orgs
				 FROM session_analytics_categories cat
				 LEFT JOIN session_analytics_counts c
					ON c.category_id = cat.id AND c.day >= ?
				 GROUP BY cat.id ORDER BY sessions DESC, cat.name LIMIT 200`,
			)
			.bind(since),
		db
			.prepare(
				`SELECT client_name, SUM(sessions) AS sessions,
					SUM(CASE WHEN outcome IN ('succeeded', 'recovered') THEN sessions ELSE 0 END) AS ended_without_errors,
					SUM(CASE WHEN outcome = 'stuck' THEN sessions ELSE 0 END) AS stuck,
					COUNT(DISTINCT org_id) AS orgs
				 FROM session_analytics_counts WHERE day >= ?
				 GROUP BY client_name ORDER BY sessions DESC LIMIT 20`,
			)
			.bind(since),
		db
			.prepare(
				`SELECT SUM(labeled) AS labeled, SUM(reused) AS reused,
					SUM(proposed_passes) AS proposed_passes, SUM(proposals) AS proposals,
					SUM(rejected_precheck) AS rejected_precheck,
					SUM(rejected_judge) AS rejected_judge, SUM(accepted) AS accepted,
					SUM(failed_three_attempts) AS failed_three_attempts,
					SUM(model_failed) AS model_failed
				 FROM session_analytics_label_stats WHERE day >= ?`,
			)
			.bind(since),
		db.prepare(
			`SELECT category_id, stuck_kind, stuck_tool, fixed_on FROM session_analytics_fix_marks`,
		),
	])
	const totals = summary?.results[0] as
		| (SummaryRow & { orgs: number })
		| undefined
	const label = (labels?.results[0] ?? {}) as Record<string, number | null>
	const count = (key: string) => label[key] ?? 0
	const rejected = count('rejected_precheck') + count('rejected_judge')
	const fixMarks = new Map(
		(
			(fixes?.results ?? []) as Array<{
				category_id: string
				stuck_kind: string
				stuck_tool: string
				fixed_on: string
			}>
		).map((row) => [
			`${row.category_id}|${row.stuck_kind}|${row.stuck_tool}`,
			row.fixed_on,
		]),
	)
	const patterns = await loadStuckPatterns(db, { since })
	const withFixes: Array<AdminSessionPattern> = []
	for (const pattern of patterns) {
		const fixedOn =
			fixMarks.get(
				`${pattern.categoryId}|${pattern.stuckKind}|${pattern.stuckTool}`,
			) ?? null
		withFixes.push({
			...pattern,
			fixedOn,
			before: fixedOn
				? await stuckShareBetween(db, pattern, shiftDay(fixedOn, -14), fixedOn)
				: null,
			after: fixedOn
				? await stuckShareBetween(db, pattern, fixedOn, shiftDay(fixedOn, 14))
				: null,
		})
	}
	return {
		windowDays: sessionInsightsWindowDays,
		optedInOrgs: (orgs?.results[0] as { n: number } | undefined)?.n ?? 0,
		summary:
			totals &&
			meetsCrossOrgMinimum({
				sessions: totals.sessions ?? 0,
				orgs: totals.orgs,
			})
				? toSummary(totals)
				: null,
		categories: (
			(categories?.results ?? []) as Array<{
				id: string
				name: string
				status: string
				sessions: number
				orgs: number
			}>
		).map((row) => ({
			id: row.id,
			name: row.name,
			status: row.status,
			sessions: meetsCrossOrgMinimum(row) ? row.sessions : null,
		})),
		patterns: withFixes,
		clients: (
			(clients?.results ?? []) as Array<{
				client_name: string
				sessions: number
				ended_without_errors: number
				stuck: number
				orgs: number
			}>
		)
			.filter(meetsCrossOrgMinimum)
			.map((row) => ({
				clientName: row.client_name,
				sessions: row.sessions,
				endedWithoutErrors: row.ended_without_errors,
				stuck: row.stuck,
			})),
		labelChecks: {
			labeled: count('labeled'),
			reused: count('reused'),
			proposedPasses: count('proposed_passes'),
			proposals: count('proposals'),
			rejectedPrecheck: count('rejected_precheck'),
			rejectedJudge: count('rejected_judge'),
			accepted: count('accepted'),
			failedThreeAttempts: count('failed_three_attempts'),
			modelFailed: count('model_failed'),
			rejectionRate:
				count('proposals') > 0 ? rejected / count('proposals') : null,
			threeAttemptFailureRate:
				count('proposed_passes') > 0
					? count('failed_three_attempts') / count('proposed_passes')
					: null,
		},
	}
}

export async function markStuckPatternFixed(
	db: D1Database,
	input: {
		categoryId: string
		stuckKind: SessionStuckKind
		stuckTool: string
		fixedOn: string
		now: Date
	},
) {
	await db
		.prepare(
			`INSERT INTO session_analytics_fix_marks (category_id, stuck_kind, stuck_tool, fixed_on, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT (category_id, stuck_kind, stuck_tool)
			 DO UPDATE SET fixed_on = excluded.fixed_on`,
		)
		.bind(
			input.categoryId,
			input.stuckKind,
			input.stuckTool,
			input.fixedOn,
			input.now.toISOString(),
		)
		.run()
}

export async function retireSessionCategory(
	db: D1Database,
	categoryId: string,
) {
	await db.batch([
		db
			.prepare(
				`UPDATE session_analytics_categories SET status = 'retired', name = 'retired ' || id WHERE id = ?`,
			)
			.bind(categoryId),
		db
			.prepare(`DELETE FROM session_analytics_counts WHERE category_id = ?`)
			.bind(categoryId),
		db
			.prepare(
				`DELETE FROM session_analytics_package_counts WHERE category_id = ?`,
			)
			.bind(categoryId),
		db
			.prepare(
				`UPDATE session_analytics_open_sessions SET category_id = NULL WHERE category_id = ?`,
			)
			.bind(categoryId),
	])
}

export type PackageSessionInsights =
	| {
			available: false
			minSessions: number
			minOrgs: number
			windowDays: number
	  }
	| {
			available: true
			windowDays: number
			sessions: number
			orgs: number
			endedWithoutErrors: number
			stuckKinds: Array<{ stuckKind: SessionStuckKind; sessions: number }>
	  }

/**
 * What a publisher sees for one public package: combined totals only, and
 * nothing until the package and each stuck kind are over the minimum.
 */
export async function loadPackageSessionInsights(
	db: D1Database,
	input: { packageId: string; now: Date },
): Promise<PackageSessionInsights> {
	const since = dayKey(input.now, sessionInsightsWindowDays)
	const [totals, kinds] = await db.batch([
		db
			.prepare(
				`SELECT SUM(sessions) AS sessions, COUNT(DISTINCT org_id) AS orgs,
					SUM(CASE WHEN outcome IN ('succeeded', 'recovered') THEN sessions ELSE 0 END) AS ended_without_errors
				 FROM session_analytics_package_counts
				 WHERE package_id = ? AND day >= ?`,
			)
			.bind(input.packageId, since),
		db
			.prepare(
				`SELECT stuck_kind, SUM(sessions) AS sessions, COUNT(DISTINCT org_id) AS orgs
				 FROM session_analytics_package_counts
				 WHERE package_id = ? AND day >= ? AND outcome = 'stuck' AND stuck_kind != ''
				 GROUP BY stuck_kind ORDER BY sessions DESC`,
			)
			.bind(input.packageId, since),
	])
	const total = totals?.results[0] as
		| {
				sessions: number | null
				orgs: number
				ended_without_errors: number | null
		  }
		| undefined
	const sessions = total?.sessions ?? 0
	const orgs = total?.orgs ?? 0
	if (!meetsCrossOrgMinimum({ sessions, orgs })) {
		return {
			available: false,
			minSessions: sessionInsightsMinSessions,
			minOrgs: sessionInsightsMinOrgs,
			windowDays: sessionInsightsWindowDays,
		}
	}
	return {
		available: true,
		windowDays: sessionInsightsWindowDays,
		sessions,
		orgs,
		endedWithoutErrors: total?.ended_without_errors ?? 0,
		stuckKinds: (
			(kinds?.results ?? []) as Array<{
				stuck_kind: string
				sessions: number
				orgs: number
			}>
		).flatMap((row) => {
			const stuckKind = parseStuckKind(row.stuck_kind)
			return stuckKind && meetsCrossOrgMinimum(row)
				? [{ stuckKind, sessions: row.sessions }]
				: []
		}),
	}
}
