import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type OrgOwnerRecipient = {
	userId: string
	email: string
}

/**
 * Resolve deliverable emails for live org owners. Personal orgs (no
 * membership row) fall back to the person whose personal org id matches.
 * Team orgs have no separate "admin" role — owners are the operator set.
 */
export async function loadOrgOwnerRecipientEmails(
	db: D1Database,
	orgId: string,
): Promise<Array<OrgOwnerRecipient>> {
	const { results: membershipRows } = await db
		.prepare(
			`SELECT user_id
			 FROM org_memberships
			 WHERE org_id = ?
			   AND role = 'owner'
			   AND deleted_at IS NULL`,
		)
		.bind(orgId)
		.all<{ user_id: string }>()
	let userIds = (membershipRows ?? []).map((row) => row.user_id)
	if (userIds.length === 0) {
		const personalOwner = await db
			.prepare(
				`SELECT stable_user_id
				 FROM users
				 WHERE (stable_user_id = ? OR personal_org_id = ?)
				   AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
			)
			.bind(orgId, orgId)
			.first<{ stable_user_id: string }>()
		userIds = personalOwner ? [personalOwner.stable_user_id] : []
	}
	if (userIds.length === 0) return []
	const placeholders = userIds.map(() => '?').join(', ')
	const { results } = await db
		.prepare(
			`SELECT stable_user_id AS user_id, email
			 FROM users
			 WHERE stable_user_id IN (${placeholders})
			   AND deleting_at IS NULL
			   AND email IS NOT NULL
			   AND TRIM(email) != ''${andLiveDeletedAtSql()}`,
		)
		.bind(...userIds)
		.all<{ user_id: string; email: string }>()
	const byId = new Map(
		(results ?? []).map((row) => [row.user_id, row.email.trim()] as const),
	)
	const recipients: Array<OrgOwnerRecipient> = []
	for (const userId of userIds) {
		const email = byId.get(userId)
		if (!email) continue
		recipients.push({ userId, email })
	}
	return recipients
}

export async function loadOrgSlug(
	db: D1Database,
	orgId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT slug FROM orgs
			 WHERE id = ? AND deleted_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ slug: string }>()
	const slug = row?.slug?.trim()
	return slug && slug.length > 0 ? slug : null
}

export async function loadOrgUsernameFallback(
	db: D1Database,
	orgId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT username FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)
			   AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(orgId, orgId)
		.first<{ username: string }>()
	const username = row?.username?.trim()
	return username && username.length > 0 ? username : null
}
