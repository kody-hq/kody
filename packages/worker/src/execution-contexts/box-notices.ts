import {
	boxExcess,
	boxPrincipal,
	compileFor,
	loadBoxAccess,
	type BoxAccess,
	type BoxAccessEntry,
} from './box-access.ts'
import { recordElevation, recordMisconfigurations } from './notices.ts'
import type { ExecutionContextRow } from './store.ts'

/** Grantees whose excess Kody tracks; larger orgs are computed on read. */
export const maxTrackedGrantees = 200

/** Every person who can run on the context in `orgId` (user, team, all members). */
export async function contextGranteeIds(
	db: D1Database,
	row: ExecutionContextRow,
	orgId: string,
): Promise<Array<string>> {
	const now = new Date().toISOString()
	const result = await db
		.prepare(
			`SELECT g.subject_id AS user_id FROM grants g
			 WHERE g.resource_type = 'execution_context' AND g.resource_id = ? AND g.org_id = ?
			   AND g.deleted_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
			   AND g.subject_type = 'user'
			 UNION
			 SELECT tm.user_id FROM grants g
			 JOIN teams t ON t.id = g.subject_id AND t.org_id = g.org_id AND t.deleted_at IS NULL
			 JOIN team_members tm ON tm.team_id = t.id AND tm.deleted_at IS NULL
			 WHERE g.resource_type = 'execution_context' AND g.resource_id = ? AND g.org_id = ?
			   AND g.deleted_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
			   AND g.subject_type = 'team'
			 UNION
			 SELECT m.user_id FROM org_memberships m
			 WHERE m.org_id = ? AND m.deleted_at IS NULL
			   AND EXISTS (
			     SELECT 1 FROM execution_contexts c WHERE c.id = ? AND c.org_id = ? AND c.all_members = 1
			     UNION SELECT 1 FROM execution_context_org_attachments a
			     WHERE a.context_id = ? AND a.org_id = ? AND a.all_members = 1)
			 LIMIT ${maxTrackedGrantees + 1}`,
		)
		.bind(
			row.id,
			orgId,
			now,
			row.id,
			orgId,
			now,
			orgId,
			row.id,
			orgId,
			row.id,
			orgId,
		)
		.all<{ user_id: string }>()
	return result.results
		.map((entry) => entry.user_id)
		.filter((id) => id !== row.operator_user_id)
}

/** What the box can do that `userId` cannot do personally in `orgId`. */
export async function excessForUser(
	db: D1Database,
	box: BoxAccess,
	orgId: string,
	userId: string,
): Promise<Array<BoxAccessEntry>> {
	if (box.principal.userId === userId && !box.principal.profileId) return []
	return boxExcess(box.entries, await compileFor(db, orgId, userId))
}

/** Misconfiguration codes for the box login and the team it is for. */
export async function contextMisconfigurations(
	db: D1Database,
	row: ExecutionContextRow,
	box: BoxAccess | null,
): Promise<Array<string>> {
	const codes: Array<string> = []
	const principal = boxPrincipal(row)
	const [operator, token, team, profile] = await Promise.all([
		db
			.prepare(
				`SELECT 1 AS ok FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
			)
			.bind(row.org_id, row.operator_user_id)
			.first(),
		row.login_token_id
			? db
					.prepare(
						`SELECT revoked_at, expires_at FROM api_tokens WHERE id = ? AND deleted_at IS NULL`,
					)
					.bind(row.login_token_id)
					.first<{
						revoked_at: string | null
						expires_at: string | null
					}>()
			: Promise.resolve(null),
		row.team_id
			? db
					.prepare(
						`SELECT 1 AS ok FROM teams WHERE id = ? AND deleted_at IS NULL`,
					)
					.bind(row.team_id)
					.first<{ ok: number }>()
			: Promise.resolve(null),
		principal.profileId
			? db
					.prepare(`SELECT assigned_team_id FROM profiles WHERE id = ?`)
					.bind(principal.profileId)
					.first<{ assigned_team_id: string | null }>()
			: Promise.resolve(null),
	])
	if (!operator) codes.push('operator_left')
	const now = new Date().toISOString()
	if (
		row.login_token_id &&
		(!token ||
			token.revoked_at ||
			(token.expires_at && token.expires_at <= now))
	) {
		codes.push('login_stale')
	}
	if (box?.profileInactive) codes.push('profile_inactive')
	if (row.team_id) {
		if (!team) codes.push('team_deleted')
		else if (!principal.profileId) codes.push('personal_login_on_team_context')
		else if (profile?.assigned_team_id !== row.team_id) {
			codes.push('profile_not_assigned_to_team')
		}
	}
	return codes
}

/**
 * Recomputes every tracked grantee's excess and the context's
 * misconfigurations in `orgId`. Never throws: notices must not break the
 * share, opt-in, or update that triggered them.
 */
export async function refreshContextNotices(
	db: D1Database,
	row: ExecutionContextRow,
	orgId: string,
	options: { userIds?: ReadonlyArray<string> } = {},
) {
	try {
		const box = await loadBoxAccess(db, row, orgId)
		const userIds = options.userIds ?? (await contextGranteeIds(db, row, orgId))
		for (const userId of userIds.slice(0, maxTrackedGrantees)) {
			if (userId === row.operator_user_id) continue
			await recordElevation(db, {
				contextId: row.id,
				orgId,
				userId,
				principal: box.principal,
				entries: await excessForUser(db, box, orgId, userId),
			})
		}
		await recordMisconfigurations(db, {
			contextId: row.id,
			orgId: row.org_id,
			codes: await contextMisconfigurations(db, row, box),
		})
		return box
	} catch (error) {
		console.error('execution-context-notices-refresh-failed', error)
		return null
	}
}
