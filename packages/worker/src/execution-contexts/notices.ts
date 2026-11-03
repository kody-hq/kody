import {
	addsEntries,
	excessFingerprint,
	type BoxAccessEntry,
	type BoxPrincipal,
} from './box-access.ts'

/**
 * Excess-access and misconfiguration notices (ADR 0096). One row per context,
 * org, kind and subject holds the current state. A notification is a move
 * to a new fingerprint that adds an entry or changes the box login; only the
 * subject dismisses an elevation, and misconfigurations are not dismissible.
 */
export type NoticeKind = 'elevation' | 'misconfigured'
export type NoticeSurface = 'execute' | 'search'

type NoticeRow = {
	context_id: string
	org_id: string
	kind: NoticeKind
	subject_user_id: string
	fingerprint: string
	detail_json: string
	raised_at: string
	dismissed_fingerprint: string | null
	delivered_execute_fingerprint: string | null
	delivered_search_fingerprint: string | null
}

export type ElevationDetail = {
	principal: BoxPrincipal
	entries: Array<BoxAccessEntry>
}

export type MisconfigDetail = { codes: Array<string> }

async function readRow(
	db: D1Database,
	key: { contextId: string; orgId: string; kind: NoticeKind; subject: string },
) {
	return await db
		.prepare(
			`SELECT * FROM execution_context_notices
			 WHERE context_id = ? AND org_id = ? AND kind = ? AND subject_user_id = ?`,
		)
		.bind(key.contextId, key.orgId, key.kind, key.subject)
		.first<NoticeRow>()
}

async function clear(
	db: D1Database,
	key: { contextId: string; orgId: string; kind: NoticeKind; subject: string },
) {
	await db
		.prepare(
			`DELETE FROM execution_context_notices
			 WHERE context_id = ? AND org_id = ? AND kind = ? AND subject_user_id = ?`,
		)
		.bind(key.contextId, key.orgId, key.kind, key.subject)
		.run()
}

async function write(
	db: D1Database,
	key: { contextId: string; orgId: string; kind: NoticeKind; subject: string },
	input: { fingerprint: string; detail: unknown; raise: boolean },
) {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO execution_context_notices
				(context_id, org_id, kind, subject_user_id, fingerprint, detail_json, raised_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (context_id, org_id, kind, subject_user_id) DO UPDATE SET
				fingerprint = excluded.fingerprint,
				detail_json = excluded.detail_json,
				updated_at = excluded.updated_at,
				raised_at = CASE WHEN ? THEN excluded.raised_at ELSE raised_at END,
				dismissed_fingerprint = CASE WHEN ? THEN NULL
					WHEN dismissed_fingerprint = fingerprint THEN excluded.fingerprint
					ELSE dismissed_fingerprint END,
				dismissed_at = CASE WHEN ? THEN NULL ELSE dismissed_at END,
				delivered_execute_fingerprint = CASE WHEN ? THEN NULL
					WHEN delivered_execute_fingerprint = fingerprint THEN excluded.fingerprint
					ELSE delivered_execute_fingerprint END,
				delivered_search_fingerprint = CASE WHEN ? THEN NULL
					WHEN delivered_search_fingerprint = fingerprint THEN excluded.fingerprint
					ELSE delivered_search_fingerprint END`,
		)
		.bind(
			key.contextId,
			key.orgId,
			key.kind,
			key.subject,
			input.fingerprint,
			JSON.stringify(input.detail),
			now,
			now,
			...Array.from({ length: 5 }, () => (input.raise ? 1 : 0)),
		)
		.run()
}

/** Records one grantee's excess; returns true when it notifies (new or added). */
export async function recordElevation(
	db: D1Database,
	input: {
		contextId: string
		orgId: string
		userId: string
		principal: BoxPrincipal
		entries: Array<BoxAccessEntry>
	},
): Promise<boolean> {
	const key = {
		contextId: input.contextId,
		orgId: input.orgId,
		kind: 'elevation' as const,
		subject: input.userId,
	}
	if (input.entries.length === 0) {
		await clear(db, key)
		return false
	}
	const fingerprint = await excessFingerprint(input.principal, input.entries)
	const previous = await readRow(db, key)
	if (previous?.fingerprint === fingerprint) return false
	const before = previous
		? (JSON.parse(previous.detail_json) as ElevationDetail)
		: null
	const raise =
		!before ||
		before.principal.userId !== input.principal.userId ||
		before.principal.profileId !== input.principal.profileId ||
		addsEntries(before.entries, input.entries)
	await write(db, key, {
		fingerprint,
		detail: { principal: input.principal, entries: input.entries },
		raise,
	})
	return raise
}

/** Records a context's misconfigurations; returns true when the set grew. */
export async function recordMisconfigurations(
	db: D1Database,
	input: { contextId: string; orgId: string; codes: Array<string> },
): Promise<boolean> {
	const key = {
		contextId: input.contextId,
		orgId: input.orgId,
		kind: 'misconfigured' as const,
		subject: '',
	}
	const codes = [...new Set(input.codes)].sort()
	if (codes.length === 0) {
		await clear(db, key)
		return false
	}
	const fingerprint = codes.join(',')
	const previous = await readRow(db, key)
	if (previous?.fingerprint === fingerprint) return false
	const before = new Set(
		previous ? (JSON.parse(previous.detail_json) as MisconfigDetail).codes : [],
	)
	const raise = codes.some((code) => !before.has(code))
	await write(db, key, { fingerprint, detail: { codes }, raise })
	return raise
}

/** Only the subject dismisses, and only the fingerprint they saw. */
export async function dismissElevation(
	db: D1Database,
	input: {
		contextId: string
		orgId: string
		userId: string
		fingerprint: string
	},
): Promise<'dismissed' | 'changed' | 'none'> {
	const row = await readRow(db, {
		contextId: input.contextId,
		orgId: input.orgId,
		kind: 'elevation',
		subject: input.userId,
	})
	if (!row) return 'none'
	if (row.fingerprint !== input.fingerprint) return 'changed'
	await db
		.prepare(
			`UPDATE execution_context_notices
			 SET dismissed_fingerprint = fingerprint, dismissed_at = ?
			 WHERE context_id = ? AND org_id = ? AND kind = 'elevation' AND subject_user_id = ?`,
		)
		.bind(new Date().toISOString(), input.contextId, input.orgId, input.userId)
		.run()
	return 'dismissed'
}

export type StoredNotice = {
	contextId: string
	kind: NoticeKind
	subjectUserId: string | null
	fingerprint: string
	dismissed: boolean
	raisedAt: string
	detail: ElevationDetail | MisconfigDetail
}

function toNotice(row: NoticeRow): StoredNotice {
	return {
		contextId: row.context_id,
		kind: row.kind,
		subjectUserId: row.subject_user_id || null,
		fingerprint: row.fingerprint,
		dismissed: row.dismissed_fingerprint === row.fingerprint,
		raisedAt: row.raised_at,
		detail: JSON.parse(row.detail_json) as ElevationDetail | MisconfigDetail,
	}
}

export async function listContextNotices(
	db: D1Database,
	input: { contextId: string; orgId: string },
): Promise<Array<StoredNotice>> {
	const result = await db
		.prepare(
			`SELECT * FROM execution_context_notices WHERE context_id = ? AND org_id = ?`,
		)
		.bind(input.contextId, input.orgId)
		.all<NoticeRow>()
	return result.results.map(toNotice)
}

/**
 * The viewer's undismissed elevations plus misconfigurations on contexts
 * they operate, in one org.
 */
export async function listNoticesForViewer(
	db: D1Database,
	input: { userId: string; orgId: string },
): Promise<Array<StoredNotice & { contextName: string }>> {
	const result = await db
		.prepare(
			`SELECT n.*, c.name AS context_name FROM execution_context_notices n
			 JOIN execution_contexts c ON c.id = n.context_id AND c.revoked_at IS NULL
			 WHERE n.org_id = ?
			   AND ((n.kind = 'elevation' AND n.subject_user_id = ?
			         AND (n.dismissed_fingerprint IS NULL OR n.dismissed_fingerprint != n.fingerprint))
			     OR (n.kind = 'misconfigured' AND c.operator_user_id = ?))
			 ORDER BY n.raised_at DESC LIMIT 20`,
		)
		.bind(input.orgId, input.userId, input.userId)
		.all<NoticeRow & { context_name: string }>()
	return result.results.map((row) => ({
		...toNotice(row),
		contextName: row.context_name,
	}))
}

/**
 * Notices this surface has not carried yet, marked delivered as they are
 * returned so each fingerprint reaches a surface once.
 */
export async function takeUndeliveredNotices(
	db: D1Database,
	input: {
		userId: string
		orgId: string
		surface: NoticeSurface
		contextId?: string
	},
) {
	const column =
		input.surface === 'execute'
			? 'delivered_execute_fingerprint'
			: 'delivered_search_fingerprint'
	const notices = (await listNoticesForViewer(db, input)).filter(
		(notice) => !input.contextId || notice.contextId === input.contextId,
	)
	const rows = await Promise.all(
		notices.map(async (notice) => {
			const result = await db
				.prepare(
					`UPDATE execution_context_notices SET ${column} = fingerprint
					 WHERE context_id = ? AND org_id = ? AND kind = ? AND subject_user_id = ?
					   AND fingerprint = ? AND (${column} IS NULL OR ${column} != fingerprint)`,
				)
				.bind(
					notice.contextId,
					input.orgId,
					notice.kind,
					notice.subjectUserId ?? '',
					notice.fingerprint,
				)
				.run()
			return (result.meta?.changes ?? 0) > 0 ? notice : null
		}),
	)
	return rows.filter((notice) => notice !== null)
}

const misconfigCopy: Record<string, string> = {
	operator_left:
		'the person who runs this machine left the org, so it takes no one else’s runs',
	login_stale:
		'the login on this machine was revoked or expired; log the machine in again',
	profile_inactive:
		'the agent profile this machine is logged in as is revoked or expired',
	team_deleted: 'the team this machine is for was deleted',
	personal_login_on_team_context:
		'this machine is for a team but is logged in with a personal account',
	profile_not_assigned_to_team:
		'this machine is for a team, but its agent profile is not assigned to that team',
}

/** The `notices` entry execute and search return. */
export function noticePayload(
	notice: StoredNotice & { contextName: string },
	href: string,
) {
	if (notice.kind === 'elevation') {
		const detail = notice.detail as ElevationDetail
		const entries = detail.entries
		return {
			kind: 'context-elevation' as const,
			contextId: notice.contextId,
			contextName: notice.contextName,
			fingerprint: notice.fingerprint,
			summary: `${notice.contextName} is logged in as an account that can do ${entries.length} thing${entries.length === 1 ? '' : 's'} you can't. Your runs there use only your own access, but anyone with host access on that machine acts with the machine's access.`,
			entries: entries.slice(0, 50),
			href,
			dismissible: true,
		}
	}
	const codes = (notice.detail as MisconfigDetail).codes
	return {
		kind: 'context-misconfigured' as const,
		contextId: notice.contextId,
		contextName: notice.contextName,
		fingerprint: notice.fingerprint,
		summary: `${notice.contextName}: ${codes.map((code) => misconfigCopy[code] ?? code).join('; ')}.`,
		codes,
		href,
		dismissible: false,
	}
}
