import {
	followRecentUpdatesPerFollow,
	isFollowPauseReason,
	type FollowRecentUpdateDetail,
} from '#universal/follows.ts'
import {
	type FollowPauseReason,
	type FollowPushCommit,
	type FollowPushPending,
	type FollowRecentUpdateRecord,
	type FollowRecord,
	type FollowStatus,
	type FollowTargetKind,
	isFollowTargetKind,
} from './types.ts'

export function hasAppDb(db: D1Database | undefined | null): db is D1Database {
	return Boolean(db && typeof db.prepare === 'function')
}

const followColumns = `id, follower_org_id, creator_user_id, creator_profile_id, target_kind,
	target_owner_id, target_id, target_name, status, paused_at, paused_reason,
	published_enabled, pushed_enabled, last_delivery_skip_reason,
	last_delivery_skip_at, created_at, updated_at`

function mapFollow(row: Record<string, unknown>): FollowRecord {
	const kind = String(row['target_kind'])
	if (!isFollowTargetKind(kind)) {
		throw new Error(`Invalid follow target kind: ${kind}`)
	}
	const status = String(row['status'])
	if (!isFollowStatus(status)) {
		throw new Error(`Invalid follow status: ${status}`)
	}
	return {
		id: String(row['id']),
		followerOrgId: String(row['follower_org_id']),
		creatorUserId: String(row['creator_user_id']),
		creatorProfileId:
			row['creator_profile_id'] == null
				? null
				: String(row['creator_profile_id']),
		targetKind: kind,
		targetOwnerId: String(row['target_owner_id']),
		targetId: String(row['target_id']),
		targetName: String(row['target_name']),
		status,
		pausedAt: nullableString(row['paused_at']),
		pausedReason: pauseReason(row['paused_reason']),
		publishedEnabled: enabledFlag(row['published_enabled']),
		pushedEnabled: enabledFlag(row['pushed_enabled']),
		lastDeliverySkipReason: nullableString(row['last_delivery_skip_reason']),
		lastDeliverySkipAt: nullableString(row['last_delivery_skip_at']),
		createdAt: String(row['created_at']),
		updatedAt: String(row['updated_at']),
	}
}

function isFollowStatus(value: string): value is FollowStatus {
	switch (value) {
		case 'active':
		case 'paused':
			return true
		default:
			return false
	}
}

function pauseReason(value: unknown): FollowPauseReason | null {
	return isFollowPauseReason(value) ? value : null
}

/** Rows written before the event columns existed deliver every event. */
function enabledFlag(value: unknown) {
	return value == null ? true : Number(value) !== 0
}

function nullableString(value: unknown) {
	if (value == null) return null
	const text = String(value)
	return text === '' ? null : text
}

export async function insertFollow(
	db: D1Database,
	row: {
		id: string
		followerOrgId: string
		creatorUserId: string
		creatorProfileId?: string | null
		targetKind: FollowTargetKind
		targetOwnerId: string
		targetId: string
		targetName: string
		createdAt: string
		/** Defaults to both events. */
		publishedEnabled?: boolean
		pushedEnabled?: boolean
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO follows (
				id, follower_org_id, creator_user_id, creator_profile_id, target_kind,
				target_owner_id, target_id, target_name, status, published_enabled,
				pushed_enabled, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.followerOrgId,
			row.creatorUserId,
			row.creatorProfileId ?? null,
			row.targetKind,
			row.targetOwnerId,
			row.targetId,
			row.targetName,
			row.publishedEnabled === false ? 0 : 1,
			row.pushedEnabled === false ? 0 : 1,
			row.createdAt,
			row.createdAt,
		)
		.run()
}

export async function getFollowByTarget(
	db: D1Database,
	input: {
		followerOrgId: string
		targetKind: FollowTargetKind
		targetId: string
	},
): Promise<FollowRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE follower_org_id = ? AND target_kind = ? AND target_id = ?`,
		)
		.bind(input.followerOrgId, input.targetKind, input.targetId)
		.first<Record<string, unknown>>()
	return row ? mapFollow(row) : null
}

export async function listFollowsByFollower(
	db: D1Database,
	followerOrgId: string,
): Promise<Array<FollowRecord>> {
	const result = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE follower_org_id = ?
			ORDER BY created_at DESC, id ASC`,
		)
		.bind(followerOrgId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapFollow)
}

/**
 * True when any org the person is a live member of follows the target,
 * active or paused.
 */
export async function viewerOrgsFollowTarget(
	db: D1Database,
	input: { personId: string; targetKind: FollowTargetKind; targetId: string },
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok
			FROM follows f
			INNER JOIN org_memberships m
				ON m.org_id = f.follower_org_id
				AND m.user_id = ?
				AND m.deleted_at IS NULL
			WHERE f.target_kind = ? AND f.target_id = ?
			LIMIT 1`,
		)
		.bind(input.personId, input.targetKind, input.targetId)
		.first<{ ok: number }>()
	return row != null
}

export async function listActiveFollowsByTarget(
	db: D1Database,
	input: { targetKind: FollowTargetKind; targetId: string },
): Promise<Array<FollowRecord>> {
	const result = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE target_kind = ? AND target_id = ? AND status = 'active'`,
		)
		.bind(input.targetKind, input.targetId)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapFollow)
}

export async function pauseFollow(
	db: D1Database,
	input: { id: string; pausedAt: string; reason: FollowPauseReason },
): Promise<void> {
	await db
		.prepare(
			`UPDATE follows
			SET status = 'paused', paused_at = ?, paused_reason = ?, updated_at = ?
			WHERE id = ? AND status = 'active'`,
		)
		.bind(input.pausedAt, input.reason, input.pausedAt, input.id)
		.run()
}

/**
 * Resume a paused follow for the given creator. Returns false when the row is
 * no longer paused (another caller resumed it, or it was deleted).
 */
export async function resumeFollow(
	db: D1Database,
	input: {
		id: string
		updatedAt: string
		creatorUserId: string
		creatorProfileId?: string | null
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE follows
			SET status = 'active', paused_at = NULL, paused_reason = NULL,
				creator_user_id = ?, creator_profile_id = ?, updated_at = ?
			WHERE id = ? AND status = 'paused'`,
		)
		.bind(
			input.creatorUserId,
			input.creatorProfileId ?? null,
			input.updatedAt,
			input.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Active followAdd retargets delivery access to the caller who just passed
 * create checks. Returns false when the row is no longer active (for example
 * delivery paused it between the read and this write).
 */
export async function retargetFollowCreator(
	db: D1Database,
	input: {
		id: string
		updatedAt: string
		creatorUserId: string
		creatorProfileId?: string | null
	},
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE follows
			SET creator_user_id = ?, creator_profile_id = ?, updated_at = ?
			WHERE id = ? AND status = 'active'`,
		)
		.bind(
			input.creatorUserId,
			input.creatorProfileId ?? null,
			input.updatedAt,
			input.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function setFollowEvents(
	db: D1Database,
	input: {
		id: string
		publishedEnabled: boolean
		pushedEnabled: boolean
		updatedAt: string
	},
): Promise<void> {
	await db
		.prepare(
			`UPDATE follows
			SET published_enabled = ?, pushed_enabled = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(
			input.publishedEnabled ? 1 : 0,
			input.pushedEnabled ? 1 : 0,
			input.updatedAt,
			input.id,
		)
		.run()
}

export async function getFollowForOrg(
	db: D1Database,
	input: { followerOrgId: string; id: string },
): Promise<FollowRecord | null> {
	const row = await db
		.prepare(
			`SELECT ${followColumns}
			FROM follows
			WHERE follower_org_id = ? AND id = ?`,
		)
		.bind(input.followerOrgId, input.id)
		.first<Record<string, unknown>>()
	return row ? mapFollow(row) : null
}

/** Deletes one follow owned by `followerOrgId`. False when it was not there. */
export async function deleteFollowForOrg(
	db: D1Database,
	input: { followerOrgId: string; id: string },
): Promise<boolean> {
	const result = await db
		.prepare(`DELETE FROM follows WHERE follower_org_id = ? AND id = ?`)
		.bind(input.followerOrgId, input.id)
		.run()
	await db
		.prepare(
			`DELETE FROM follow_recent_updates WHERE follower_org_id = ? AND follow_id = ?`,
		)
		.bind(input.followerOrgId, input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/**
 * Store one unhandled follow event for the follow's own org. A retried
 * delivery with the same dedupe key is a no-op, a follow that is gone or
 * belongs to another org stores nothing, and only the newest
 * {@link followRecentUpdatesPerFollow} rows per follow are kept.
 */
export async function insertFollowRecentUpdate(
	db: D1Database,
	input: {
		id: string
		followerOrgId: string
		followId: string
		dedupeKey: string
		detail: FollowRecentUpdateDetail
		occurredAt: string
		createdAt: string
	},
): Promise<boolean> {
	const inserted = await db
		.prepare(
			`INSERT OR IGNORE INTO follow_recent_updates (
				id, follower_org_id, follow_id, event, dedupe_key, detail_json,
				occurred_at, created_at
			)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?
			WHERE EXISTS (
				SELECT 1 FROM follows WHERE id = ? AND follower_org_id = ?
			)`,
		)
		.bind(
			input.id,
			input.followerOrgId,
			input.followId,
			input.detail.event,
			input.dedupeKey,
			JSON.stringify(input.detail),
			input.occurredAt,
			input.createdAt,
			input.followId,
			input.followerOrgId,
		)
		.run()
	await db
		.prepare(
			`DELETE FROM follow_recent_updates
			WHERE follow_id = ? AND id NOT IN (
				SELECT id FROM follow_recent_updates
				WHERE follow_id = ?
				ORDER BY occurred_at DESC, created_at DESC, id DESC
				LIMIT ?
			)`,
		)
		.bind(input.followId, input.followId, followRecentUpdatesPerFollow)
		.run()
	return (inserted.meta.changes ?? 0) > 0
}

/** Newest first. Only rows whose follow still belongs to the same org. */
export async function listFollowRecentUpdates(
	db: D1Database,
	input: { followerOrgId: string; followId?: string; limit: number },
): Promise<Array<FollowRecentUpdateRecord>> {
	const byFollow = input.followId !== undefined
	const result = await db
		.prepare(
			`SELECT u.id, u.follow_id, u.detail_json, u.occurred_at,
				f.target_name, f.target_kind
			FROM follow_recent_updates u
			JOIN follows f
				ON f.id = u.follow_id AND f.follower_org_id = u.follower_org_id
			WHERE u.follower_org_id = ?${byFollow ? ' AND u.follow_id = ?' : ''}
			ORDER BY u.occurred_at DESC, u.created_at DESC, u.id DESC
			LIMIT ?`,
		)
		.bind(
			input.followerOrgId,
			...(byFollow ? [input.followId] : []),
			input.limit,
		)
		.all<Record<string, unknown>>()
	const records: Array<FollowRecentUpdateRecord> = []
	for (const row of result.results ?? []) {
		const kind = String(row['target_kind'])
		const detail = parseRecentUpdateDetail(row['detail_json'])
		if (!isFollowTargetKind(kind) || !detail) continue
		records.push({
			id: String(row['id']),
			followId: String(row['follow_id']),
			targetName: String(row['target_name']),
			targetKind: kind,
			detail,
			occurredAt: String(row['occurred_at']),
		})
	}
	return records
}

function parseRecentUpdateDetail(
	value: unknown,
): FollowRecentUpdateDetail | null {
	try {
		const parsed = JSON.parse(String(value)) as FollowRecentUpdateDetail
		return parsed.event === 'published' || parsed.event === 'pushed'
			? parsed
			: null
	} catch {
		return null
	}
}

/** Drop rows stored before the cutoff and rows whose follow is gone. */
export async function deleteStaleFollowRecentUpdates(
	db: D1Database,
	cutoffIso: string,
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM follow_recent_updates
			WHERE created_at <= ?
				OR NOT EXISTS (
					SELECT 1 FROM follows f
					WHERE f.id = follow_recent_updates.follow_id
						AND f.follower_org_id = follow_recent_updates.follower_org_id
				)`,
		)
		.bind(cutoffIso)
		.run()
	return result.meta.changes ?? 0
}

export async function markFollowDeliverySkip(
	db: D1Database,
	input: { id: string; reason: string; skippedAt: string },
): Promise<void> {
	await db
		.prepare(
			`UPDATE follows
			SET last_delivery_skip_reason = ?, last_delivery_skip_at = ?, updated_at = ?
			WHERE id = ?`,
		)
		.bind(input.reason, input.skippedAt, input.skippedAt, input.id)
		.run()
}

export async function deletePausedFollowsBefore(
	db: D1Database,
	cutoffIso: string,
): Promise<number> {
	const result = await db
		.prepare(
			`DELETE FROM follows
			WHERE status = 'paused' AND paused_at IS NOT NULL AND paused_at <= ?`,
		)
		.bind(cutoffIso)
		.run()
	return result.meta.changes ?? 0
}

function mapPending(row: Record<string, unknown>): FollowPushPending {
	const kind = String(row['target_kind'])
	if (!isFollowTargetKind(kind)) {
		throw new Error(`Invalid follow push target kind: ${kind}`)
	}
	return {
		targetKind: kind,
		targetId: String(row['target_id']),
		windowStartedAt: String(row['window_started_at']),
		beforeCommit: nullableString(row['before_commit']),
		afterCommit: nullableString(row['after_commit']),
		ref: String(row['ref']),
		commits: parseCommits(row['commits_json']),
		totalCommitsCount: Number(row['total_commits_count'] ?? 0),
		updatedAt: String(row['updated_at']),
		revision: Number(row['revision'] ?? 0),
		generation: String(row['generation'] ?? ''),
	}
}

function parseCommits(value: unknown): Array<FollowPushCommit> {
	if (typeof value !== 'string' || !value) return []
	try {
		const parsed = JSON.parse(value) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter(isFollowPushCommit)
	} catch {
		return []
	}
}

function isFollowPushCommit(value: unknown): value is FollowPushCommit {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const record = value as Record<string, unknown>
	return typeof record['id'] === 'string'
}

export async function getFollowPushPending(
	db: D1Database,
	input: { targetKind: FollowTargetKind; targetId: string },
): Promise<FollowPushPending | null> {
	const row = await db
		.prepare(
			`SELECT target_kind, target_id, window_started_at, before_commit,
				after_commit, ref, commits_json, total_commits_count, updated_at,
				revision, generation
			FROM follow_push_pending
			WHERE target_kind = ? AND target_id = ?`,
		)
		.bind(input.targetKind, input.targetId)
		.first<Record<string, unknown>>()
	return row ? mapPending(row) : null
}

/**
 * Write the open window with compare-and-swap. `expected === null` means the
 * caller saw no row: insert a fresh window with a new `generation`, and miss
 * if any row exists. Otherwise update only while the stored `revision` and
 * `generation` still match what the caller read; a deleted row is never
 * recreated by a stale writer, and a reinserted row (new generation) never
 * matches an old snapshot even though its revision restarts at 0. A miss
 * means a concurrent writer won; the caller re-reads and merges. `updated_at`
 * stays webhook event time for tip ordering and may not change on a write.
 */
export async function upsertFollowPushPending(
	db: D1Database,
	row: FollowPushPending,
	expected: Pick<FollowPushPending, 'revision' | 'generation'> | null,
): Promise<boolean> {
	const values = [
		row.windowStartedAt,
		row.beforeCommit,
		row.afterCommit,
		row.ref,
		JSON.stringify(row.commits),
		row.totalCommitsCount,
		row.updatedAt,
	]
	const result =
		expected === null
			? await db
					.prepare(
						`INSERT INTO follow_push_pending (
							target_kind, target_id, window_started_at, before_commit,
							after_commit, ref, commits_json, total_commits_count, updated_at,
							revision, generation
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
						ON CONFLICT (target_kind, target_id) DO NOTHING`,
					)
					.bind(row.targetKind, row.targetId, ...values, crypto.randomUUID())
					.run()
			: await db
					.prepare(
						`UPDATE follow_push_pending SET
							window_started_at = ?,
							before_commit = ?,
							after_commit = ?,
							ref = ?,
							commits_json = ?,
							total_commits_count = ?,
							updated_at = ?,
							revision = revision + 1
						WHERE target_kind = ? AND target_id = ?
							AND revision = ? AND generation = ?`,
					)
					.bind(
						...values,
						row.targetKind,
						row.targetId,
						expected.revision,
						expected.generation,
					)
					.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listDueFollowPushPending(
	db: D1Database,
	cutoffIso: string,
): Promise<Array<FollowPushPending>> {
	const result = await db
		.prepare(
			`SELECT target_kind, target_id, window_started_at, before_commit,
				after_commit, ref, commits_json, total_commits_count, updated_at,
				revision, generation
			FROM follow_push_pending
			WHERE window_started_at <= ?`,
		)
		.bind(cutoffIso)
		.all<Record<string, unknown>>()
	return (result.results ?? []).map(mapPending)
}

/** Deletes the flushed snapshot only when no newer write replaced it. */
export async function deleteFollowPushPendingIfUnchanged(
	db: D1Database,
	row: Pick<
		FollowPushPending,
		'targetKind' | 'targetId' | 'revision' | 'generation'
	>,
): Promise<boolean> {
	const result = await db
		.prepare(
			`DELETE FROM follow_push_pending
			WHERE target_kind = ? AND target_id = ? AND revision = ?
				AND generation = ?`,
		)
		.bind(row.targetKind, row.targetId, row.revision, row.generation)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function ensureFollowTables(db: D1Database) {
	const statements = [
		`CREATE TABLE IF NOT EXISTS follows (
			id TEXT PRIMARY KEY NOT NULL,
			follower_org_id TEXT NOT NULL,
			creator_user_id TEXT NOT NULL,
			creator_profile_id TEXT,
			target_kind TEXT NOT NULL CHECK (target_kind IN ('package', 'repo')),
			target_owner_id TEXT NOT NULL,
			target_id TEXT NOT NULL,
			target_name TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('active', 'paused')) DEFAULT 'active',
			paused_at TEXT,
			paused_reason TEXT,
			published_enabled INTEGER NOT NULL DEFAULT 1,
			pushed_enabled INTEGER NOT NULL DEFAULT 1,
			last_delivery_skip_reason TEXT,
			last_delivery_skip_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE (follower_org_id, target_kind, target_id)
		)`,
		`CREATE INDEX IF NOT EXISTS follows_target_idx
			ON follows (target_kind, target_id, status)`,
		`CREATE INDEX IF NOT EXISTS follows_paused_idx
			ON follows (status, paused_at)`,
		`CREATE INDEX IF NOT EXISTS follows_follower_idx
			ON follows (follower_org_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS follow_push_pending (
			target_kind TEXT NOT NULL CHECK (target_kind IN ('package', 'repo')),
			target_id TEXT NOT NULL,
			window_started_at TEXT NOT NULL,
			before_commit TEXT,
			after_commit TEXT,
			ref TEXT NOT NULL,
			commits_json TEXT NOT NULL,
			total_commits_count INTEGER NOT NULL,
			updated_at TEXT NOT NULL,
			revision INTEGER NOT NULL DEFAULT 0,
			generation TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (target_kind, target_id)
		)`,
		`CREATE TABLE IF NOT EXISTS follow_recent_updates (
			id TEXT PRIMARY KEY NOT NULL,
			follower_org_id TEXT NOT NULL,
			follow_id TEXT NOT NULL,
			event TEXT NOT NULL CHECK (event IN ('published', 'pushed')),
			dedupe_key TEXT NOT NULL,
			detail_json TEXT NOT NULL,
			occurred_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (follow_id, dedupe_key)
		)`,
		`CREATE INDEX IF NOT EXISTS follow_recent_updates_org_idx
			ON follow_recent_updates (follower_org_id, occurred_at)`,
		`CREATE INDEX IF NOT EXISTS follow_recent_updates_follow_idx
			ON follow_recent_updates (follow_id, occurred_at)`,
		`CREATE INDEX IF NOT EXISTS follow_recent_updates_created_idx
			ON follow_recent_updates (created_at)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
