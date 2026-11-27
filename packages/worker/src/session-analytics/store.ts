import type {
	SessionAnalyticsState,
	SessionOutcome,
	SessionStuckKind,
	SessionSurface,
} from '#universal/session-analytics.ts'

/** A session closes this long after its last linked call. */
export const sessionIdleCloseMs = 30 * 60 * 1000
/** A linked call this long after the session started begins a new session. */
export const sessionMaxAgeMs = 4 * 60 * 60 * 1000
/** Count rows older than this are deleted by the daily sweep. */
export const sessionCountsRetentionDays = 400
const maxSessionPackages = 5

export type SessionLink = { kind: 'conversation' | 'object'; key: string }

/** Counters for one open session. Every field is an enum, number, or id. */
export type OpenSession = {
	sessionId: string
	orgId: string
	userId: string
	startedAt: string
	lastCallAt: string
	callCount: number
	errorCount: number
	clientName: string
	surface: SessionSurface
	categoryId: string | null
	categorySource: 'memory_context' | 'search_task' | 'none'
	searchTask: string | null
	streakKind: SessionStuckKind | null
	streakTool: string | null
	streakLength: number
	maxStreak: number
	maxStreakKind: SessionStuckKind | null
	maxStreakTool: string | null
	recovered: boolean
	nudged: boolean
	lastCallFailed: boolean
	packageIds: Array<string>
}

type OpenSessionRow = {
	session_id: string
	org_id: string
	user_id: string
	started_at: string
	last_call_at: string
	call_count: number
	error_count: number
	client_name: string
	surface: SessionSurface
	category_id: string | null
	category_source: OpenSession['categorySource']
	search_task: string | null
	streak_kind: SessionStuckKind | null
	streak_tool: string | null
	streak_length: number
	max_streak: number
	max_streak_kind: SessionStuckKind | null
	max_streak_tool: string | null
	recovered: number
	nudged: number
	last_call_failed: number
	package_ids: string
}

function parsePackageIds(value: string): Array<string> {
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === 'string')
			: []
	} catch {
		return []
	}
}

function fromRow(row: OpenSessionRow): OpenSession {
	return {
		sessionId: row.session_id,
		orgId: row.org_id,
		userId: row.user_id,
		startedAt: row.started_at,
		lastCallAt: row.last_call_at,
		callCount: row.call_count,
		errorCount: row.error_count,
		clientName: row.client_name,
		surface: row.surface,
		categoryId: row.category_id,
		categorySource: row.category_source,
		searchTask: row.search_task,
		streakKind: row.streak_kind,
		streakTool: row.streak_tool,
		streakLength: row.streak_length,
		maxStreak: row.max_streak,
		maxStreakKind: row.max_streak_kind,
		maxStreakTool: row.max_streak_tool,
		recovered: row.recovered === 1,
		nudged: row.nudged === 1,
		lastCallFailed: row.last_call_failed === 1,
		packageIds: parsePackageIds(row.package_ids),
	}
}

export function newOpenSession(input: {
	orgId: string
	userId: string
	clientName: string
	surface: SessionSurface
	now: Date
}): OpenSession {
	const at = input.now.toISOString()
	return {
		sessionId: crypto.randomUUID(),
		orgId: input.orgId,
		userId: input.userId,
		startedAt: at,
		lastCallAt: at,
		callCount: 0,
		errorCount: 0,
		clientName: input.clientName,
		surface: input.surface,
		categoryId: null,
		categorySource: 'none',
		searchTask: null,
		streakKind: null,
		streakTool: null,
		streakLength: 0,
		maxStreak: 0,
		maxStreakKind: null,
		maxStreakTool: null,
		recovered: false,
		nudged: false,
		lastCallFailed: false,
		packageIds: [],
	}
}

export type SessionCall = {
	tool: string
	stuckKind: SessionStuckKind | null
	searchTask?: string | null
	publicPackageIds?: ReadonlyArray<string>
	nudged?: boolean
	/** The call is still running, so it neither fails nor ends a streak. */
	pending?: boolean
}

/** Fold one call into the session counters. Pure. */
export function applySessionCall(
	session: OpenSession,
	call: SessionCall,
	now: Date,
): OpenSession {
	const next: OpenSession = {
		...session,
		lastCallAt: now.toISOString(),
		callCount: session.callCount + 1,
		searchTask: session.searchTask ?? call.searchTask ?? null,
		nudged: session.nudged || call.nudged === true,
		packageIds: [
			...new Set([...session.packageIds, ...(call.publicPackageIds ?? [])]),
		].slice(0, maxSessionPackages),
	}
	if (call.stuckKind) {
		const continues =
			session.streakKind === call.stuckKind && session.streakTool === call.tool
		next.errorCount = session.errorCount + 1
		next.streakKind = call.stuckKind
		next.streakTool = call.tool
		next.streakLength = continues ? session.streakLength + 1 : 1
		next.lastCallFailed = true
		if (next.streakLength > session.maxStreak) {
			next.maxStreak = next.streakLength
			next.maxStreakKind = call.stuckKind
			next.maxStreakTool = call.tool
		}
		return next
	}
	if (call.pending) return next
	next.lastCallFailed = false
	if (session.streakLength >= 2 && session.streakTool === call.tool) {
		next.recovered = true
	}
	if (session.streakTool === call.tool) {
		next.streakKind = null
		next.streakTool = null
		next.streakLength = 0
	}
	return next
}

export type SessionResult = {
	outcome: SessionOutcome
	stuckKind: SessionStuckKind | null
	stuckTool: string | null
}

/** How a session ended, counted from its counters. Pure. */
export function sessionResult(session: OpenSession): SessionResult {
	const worst = {
		stuckKind: session.maxStreakKind,
		stuckTool: session.maxStreakTool,
	}
	if (session.callCount < 2) {
		return session.lastCallFailed
			? {
					outcome: 'unknown',
					stuckKind: session.streakKind,
					stuckTool: session.streakTool,
				}
			: { outcome: 'unknown', stuckKind: null, stuckTool: null }
	}
	if (session.lastCallFailed) {
		return session.streakLength >= 2
			? {
					outcome: 'stuck',
					stuckKind: session.streakKind,
					stuckTool: session.streakTool,
				}
			: {
					outcome: 'abandoned',
					stuckKind: session.streakKind,
					stuckTool: session.streakTool,
				}
	}
	if (session.streakLength >= 2) {
		return {
			outcome: 'stuck',
			stuckKind: session.streakKind,
			stuckTool: session.streakTool,
		}
	}
	if (session.recovered) return { outcome: 'recovered', ...worst }
	return { outcome: 'succeeded', stuckKind: null, stuckTool: null }
}

export function isSessionExpired(session: OpenSession, now: Date) {
	return (
		now.getTime() - Date.parse(session.lastCallAt) > sessionIdleCloseMs ||
		now.getTime() - Date.parse(session.startedAt) > sessionMaxAgeMs
	)
}

/** The open session any of these links belongs to, strongest link first. */
export async function findOpenSession(
	db: D1Database,
	input: { orgId: string; userId: string; links: ReadonlyArray<SessionLink> },
): Promise<OpenSession | null> {
	for (const link of input.links) {
		const row = await db
			.prepare(
				`SELECT s.* FROM session_analytics_links l
				 JOIN session_analytics_open_sessions s ON s.session_id = l.session_id
				 WHERE l.org_id = ? AND l.user_id = ? AND l.link_kind = ? AND l.link_key = ?`,
			)
			.bind(input.orgId, input.userId, link.kind, link.key)
			.first<OpenSessionRow>()
		if (row) return fromRow(row)
	}
	return null
}

function saveSessionStatements(
	db: D1Database,
	session: OpenSession,
	links: ReadonlyArray<SessionLink>,
) {
	return [
		db
			.prepare(
				`INSERT INTO session_analytics_open_sessions (
					session_id, org_id, user_id, started_at, last_call_at, call_count,
					error_count, client_name, surface, category_id, category_source,
					search_task, streak_kind, streak_tool, streak_length, max_streak,
					max_streak_kind, max_streak_tool, recovered, nudged,
					last_call_failed, package_ids
				) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE EXISTS (
					SELECT 1 FROM orgs
					WHERE id = ? AND session_analytics = 'enabled' AND deleted_at IS NULL
				)
				ON CONFLICT (session_id) DO UPDATE SET
					last_call_at = excluded.last_call_at,
					call_count = excluded.call_count,
					error_count = excluded.error_count,
					category_id = excluded.category_id,
					category_source = excluded.category_source,
					search_task = excluded.search_task,
					streak_kind = excluded.streak_kind,
					streak_tool = excluded.streak_tool,
					streak_length = excluded.streak_length,
					max_streak = excluded.max_streak,
					max_streak_kind = excluded.max_streak_kind,
					max_streak_tool = excluded.max_streak_tool,
					recovered = excluded.recovered,
					nudged = excluded.nudged,
					last_call_failed = excluded.last_call_failed,
					package_ids = excluded.package_ids`,
			)
			.bind(
				session.sessionId,
				session.orgId,
				session.userId,
				session.startedAt,
				session.lastCallAt,
				session.callCount,
				session.errorCount,
				session.clientName,
				session.surface,
				session.categoryId,
				session.categorySource,
				session.searchTask,
				session.streakKind,
				session.streakTool,
				session.streakLength,
				session.maxStreak,
				session.maxStreakKind,
				session.maxStreakTool,
				session.recovered ? 1 : 0,
				session.nudged ? 1 : 0,
				session.lastCallFailed ? 1 : 0,
				JSON.stringify(session.packageIds),
				session.orgId,
			),
		...links.map((link) =>
			db
				.prepare(
					`INSERT INTO session_analytics_links (org_id, user_id, link_kind, link_key, session_id)
					 SELECT ?, ?, ?, ?, ?
					 WHERE EXISTS (
					 	SELECT 1 FROM orgs
					 	WHERE id = ? AND session_analytics = 'enabled' AND deleted_at IS NULL
					 )
					 ON CONFLICT (org_id, user_id, link_kind, link_key)
					 DO UPDATE SET session_id = excluded.session_id`,
				)
				.bind(
					session.orgId,
					session.userId,
					link.kind,
					link.key,
					session.sessionId,
					session.orgId,
				),
		),
	]
}

export async function saveOpenSession(
	db: D1Database,
	session: OpenSession,
	links: ReadonlyArray<SessionLink>,
) {
	await db.batch(saveSessionStatements(db, session, links))
}

/**
 * Close a session: add it to the count rows and delete the session row and
 * its link keys in one batch, so no per-session row outlives the session.
 * Every write checks the org is still opted in inside the statement, so a
 * call that raced an opt-out stores nothing.
 */
export async function closeSession(db: D1Database, session: OpenSession) {
	const result = sessionResult(session)
	const day = session.lastCallAt.slice(0, 10)
	const linked = session.callCount >= 2 ? 1 : 0
	const stuckKind = result.stuckKind ?? ''
	const statements = [
		db
			.prepare(
				`INSERT INTO session_analytics_counts (
					org_id, user_id, day, category_id, outcome, stuck_kind, stuck_tool,
					client_name, surface, sessions, linked_sessions, calls, errors,
					nudged_sessions
				) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
				WHERE EXISTS (
					SELECT 1 FROM orgs
					WHERE id = ? AND session_analytics = 'enabled' AND deleted_at IS NULL
				)
				ON CONFLICT (
					org_id, user_id, day, category_id, outcome, stuck_kind, stuck_tool,
					client_name, surface
				) DO UPDATE SET
					sessions = sessions + 1,
					linked_sessions = linked_sessions + excluded.linked_sessions,
					calls = calls + excluded.calls,
					errors = errors + excluded.errors,
					nudged_sessions = nudged_sessions + excluded.nudged_sessions`,
			)
			.bind(
				session.orgId,
				session.userId,
				day,
				session.categoryId ?? '',
				result.outcome,
				stuckKind,
				result.stuckTool ?? '',
				session.clientName,
				session.surface,
				linked,
				session.callCount,
				session.errorCount,
				session.nudged ? 1 : 0,
				session.orgId,
			),
		...session.packageIds.map((packageId) =>
			db
				.prepare(
					`INSERT INTO session_analytics_package_counts (
						package_id, org_id, user_id, day, category_id, outcome, stuck_kind,
						stuck_tool, sessions
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1
					WHERE EXISTS (
						SELECT 1 FROM orgs
						WHERE id = ? AND session_analytics = 'enabled' AND deleted_at IS NULL
					)
					ON CONFLICT (
						package_id, org_id, user_id, day, category_id, outcome, stuck_kind,
						stuck_tool
					)
					DO UPDATE SET sessions = sessions + 1`,
				)
				.bind(
					packageId,
					session.orgId,
					session.userId,
					day,
					session.categoryId ?? '',
					result.outcome,
					stuckKind,
					result.stuckTool ?? '',
					session.orgId,
				),
		),
		db
			.prepare(`DELETE FROM session_analytics_links WHERE session_id = ?`)
			.bind(session.sessionId),
		db
			.prepare(
				`DELETE FROM session_analytics_open_sessions WHERE session_id = ?`,
			)
			.bind(session.sessionId),
	]
	await db.batch(statements)
}

/**
 * Close every session past its idle or age limit, drop sessions of orgs that
 * are no longer opted in, and delete count rows past retention.
 */
export async function sweepSessionAnalytics(db: D1Database, now: Date) {
	await db.batch([
		db.prepare(
			`DELETE FROM session_analytics_links WHERE org_id NOT IN (
				SELECT id FROM orgs WHERE session_analytics = 'enabled' AND deleted_at IS NULL
			)`,
		),
		db.prepare(
			`DELETE FROM session_analytics_open_sessions WHERE org_id NOT IN (
				SELECT id FROM orgs WHERE session_analytics = 'enabled' AND deleted_at IS NULL
			)`,
		),
	])
	const idleBefore = new Date(now.getTime() - sessionIdleCloseMs).toISOString()
	const startedBefore = new Date(now.getTime() - sessionMaxAgeMs).toISOString()
	const expired = await db
		.prepare(
			`SELECT * FROM session_analytics_open_sessions
			 WHERE last_call_at < ? OR started_at < ? LIMIT 500`,
		)
		.bind(idleBefore, startedBefore)
		.all<OpenSessionRow>()
	for (const row of expired.results) await closeSession(db, fromRow(row))
	const cutoff = new Date(
		now.getTime() - sessionCountsRetentionDays * 24 * 60 * 60 * 1000,
	)
		.toISOString()
		.slice(0, 10)
	await db.batch(
		[
			'session_analytics_counts',
			'session_analytics_package_counts',
			'session_analytics_label_stats',
		].map((table) =>
			db.prepare(`DELETE FROM ${table} WHERE day < ?`).bind(cutoff),
		),
	)
	return { closed: expired.results.length }
}

const orgScopedTables = [
	'session_analytics_links',
	'session_analytics_open_sessions',
	'session_analytics_counts',
	'session_analytics_package_counts',
] as const

/** Everything session analytics stored for one org. */
export function deleteOrgSessionAnalyticsStatements(
	db: D1Database,
	orgId: string,
	options: { onlyWhenState?: SessionAnalyticsState } = {},
) {
	const state = options.onlyWhenState
	if (!state) {
		return orgScopedTables.map((table) =>
			db.prepare(`DELETE FROM ${table} WHERE org_id = ?`).bind(orgId),
		)
	}
	return orgScopedTables.map((table) =>
		db
			.prepare(
				`DELETE FROM ${table} WHERE org_id = ? AND EXISTS (
					SELECT 1 FROM orgs WHERE id = ? AND session_analytics = ?
				)`,
			)
			.bind(orgId, orgId, state),
	)
}

/** Everything session analytics stored for one person, in every org. */
export function deleteUserSessionAnalyticsStatements(
	db: D1Database,
	userId: string,
) {
	return orgScopedTables.map((table) =>
		db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId),
	)
}
