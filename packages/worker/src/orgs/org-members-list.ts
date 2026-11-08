import type { OrgRole } from '@kody-internal/shared/request-context.ts'

export type ListedOrgMember = {
	userId: string
	username: string | null
	displayName: string | null
	avatarKey: string | null
	role: OrgRole
}

export type ListedOrgInvite = {
	id: string
	kind: string
	role: OrgRole | null
	inviteeEmail: string | null
	inviteeUsername: string | null
	expiresAt: string
	createdAt: string
}

const orgRoleValues = ['owner', 'admin', 'member', 'billing'] as const

function isOrgRole(value: string): value is OrgRole {
	return (orgRoleValues as ReadonlyArray<string>).includes(value)
}

/**
 * Live memberships for an organization, with public identity when the person
 * still has a live user row.
 */
export async function listOrgMembers(
	db: D1Database,
	orgId: string,
): Promise<Array<ListedOrgMember>> {
	const rows = await db
		.prepare(
			`SELECT m.user_id AS user_id,
			        m.role AS role,
			        u.username AS username,
			        u.display_name AS display_name,
			        u.avatar_key AS avatar_key
			 FROM org_memberships m
			 LEFT JOIN users u
			   ON u.stable_user_id = m.user_id
			  AND u.deleted_at IS NULL
			 WHERE m.org_id = ?
			   AND m.deleted_at IS NULL
			 ORDER BY
			   CASE m.role
			     WHEN 'owner' THEN 0
			     WHEN 'admin' THEN 1
			     WHEN 'member' THEN 2
			     WHEN 'billing' THEN 3
			     ELSE 4
			   END,
			   COALESCE(u.username, m.user_id) ASC`,
		)
		.bind(orgId)
		.all<{
			user_id: string
			role: string
			username: string | null
			display_name: string | null
			avatar_key: string | null
		}>()
	return (rows.results ?? []).flatMap((row) => {
		if (!isOrgRole(row.role)) return []
		return [
			{
				userId: row.user_id,
				username: row.username,
				displayName: row.display_name,
				avatarKey: row.avatar_key,
				role: row.role,
			},
		]
	})
}

/**
 * Live pending invites for an organization. Expired rows stay `pending` in
 * storage until something marks them; this list hides them.
 */
export async function getLiveOrgMembership(
	db: D1Database,
	orgId: string,
	userId: string,
) {
	return await db
		.prepare(
			`SELECT role FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ role: OrgRole }>()
}

export async function countLiveOwners(db: D1Database, orgId: string) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM org_memberships
			 WHERE org_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

export async function listPendingOrgInvites(
	db: D1Database,
	orgId: string,
	now = new Date().toISOString(),
): Promise<Array<ListedOrgInvite>> {
	const rows = await db
		.prepare(
			`SELECT id, kind, role, invitee_email, invitee_username,
			        expires_at, created_at
			 FROM invites
			 WHERE org_id = ?
			   AND status = 'pending'
			   AND expires_at > ?
			 ORDER BY created_at DESC`,
		)
		.bind(orgId, now)
		.all<{
			id: string
			kind: string
			role: string | null
			invitee_email: string | null
			invitee_username: string | null
			expires_at: string
			created_at: string
		}>()
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		kind: row.kind,
		role: row.role && isOrgRole(row.role) ? row.role : null,
		inviteeEmail: row.invitee_email,
		inviteeUsername: row.invitee_username,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	}))
}
