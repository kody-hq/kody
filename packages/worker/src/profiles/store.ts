/**
 * soft-delete-read-filter: opt-out (purgeProfiles hard-deletes orphaned profile grants)
 */
/**
 * Profile storage (ADR 0092). Profile rows and their `grants` rows (subject
 * type `profile`) never feed a person's roles or org binding, so these writes
 * do not bump `orgs.access_epoch`.
 */
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	maxProfileDepth,
	profilePurgeAfterDays,
	type ProfileRow,
	type RequestedProfileGrant,
} from './rules.ts'

const profileColumns = `id, org_id, owner_kind, acting_user_id, parent_profile_id, name,
	depth, expires_at, revoked_at, revoked_by_user_id, created_by_user_id,
	created_by_profile_id, created_at, updated_at`

/**
 * The chain from the root down to `profileId` (root first), in one recursive
 * query. Empty when the profile is missing or outside `orgId`.
 */
export async function loadProfileChain(
	db: D1Database,
	input: { orgId: string; profileId: string },
): Promise<Array<ProfileRow>> {
	const result = await db
		.prepare(
			`WITH RECURSIVE chain(${profileColumns}, hop) AS (
				SELECT ${profileColumns}, 0 FROM profiles WHERE id = ? AND org_id = ?
				UNION ALL
				SELECT p.id, p.org_id, p.owner_kind, p.acting_user_id,
					p.parent_profile_id, p.name, p.depth, p.expires_at, p.revoked_at,
					p.revoked_by_user_id, p.created_by_user_id, p.created_by_profile_id,
					p.created_at, p.updated_at, chain.hop + 1
				FROM profiles p JOIN chain ON p.id = chain.parent_profile_id
				WHERE chain.hop < ? AND p.org_id = chain.org_id
			)
			SELECT ${profileColumns} FROM chain ORDER BY depth ASC`,
		)
		.bind(input.profileId, input.orgId, maxProfileDepth)
		.all<ProfileRow>()
	return result.results
}

export async function listProfileRows(
	db: D1Database,
	input: { orgId: string; actingUserId: string | null },
): Promise<Array<ProfileRow>> {
	const statement =
		input.actingUserId === null
			? db
					.prepare(
						`SELECT ${profileColumns} FROM profiles WHERE org_id = ?
						 ORDER BY depth ASC, created_at ASC, id ASC`,
					)
					.bind(input.orgId)
			: db
					.prepare(
						`SELECT ${profileColumns} FROM profiles
						 WHERE org_id = ? AND acting_user_id = ?
						 ORDER BY depth ASC, created_at ASC, id ASC`,
					)
					.bind(input.orgId, input.actingUserId)
	return (await statement.all<ProfileRow>()).results
}

export async function countActiveProfiles(
	db: D1Database,
	input: { orgId: string; actingUserId: string; now: string },
) {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count FROM profiles
			 WHERE org_id = ? AND acting_user_id = ? AND revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > ?)`,
		)
		.bind(input.orgId, input.actingUserId, input.now)
		.first<{ count: number }>()
	return row?.count ?? 0
}

export async function profileNameTaken(
	db: D1Database,
	input: {
		orgId: string
		actingUserId: string
		parentProfileId: string | null
		name: string
	},
) {
	const row = await db
		.prepare(
			`SELECT id FROM profiles
			 WHERE org_id = ? AND acting_user_id = ?
			   AND COALESCE(parent_profile_id, '') = ? AND name = ?`,
		)
		.bind(
			input.orgId,
			input.actingUserId,
			input.parentProfileId ?? '',
			input.name,
		)
		.first<{ id: string }>()
	return row !== null
}

export type ProfileGrantRow = {
	resourceType: string
	resourceId: string
	permissions: Array<OrgPermission>
}

/** Live profile grants keyed by profile id. */
export async function loadProfileGrants(
	db: D1Database,
	input: { orgId: string; profileIds: ReadonlyArray<string> },
): Promise<Map<string, Array<ProfileGrantRow>>> {
	const byProfile = new Map<string, Array<ProfileGrantRow>>()
	if (input.profileIds.length === 0) return byProfile
	const placeholders = input.profileIds.map(() => '?').join(', ')
	const result = await db
		.prepare(
			`SELECT g.id AS grant_id, g.subject_id, g.resource_type, g.resource_id,
				gp.permission
			 FROM grants g JOIN grant_permissions gp ON gp.grant_id = g.id
			 WHERE g.org_id = ? AND g.subject_type = 'profile'
			   AND g.deleted_at IS NULL
			   AND (g.expires_at IS NULL OR g.expires_at > ?)
			   AND g.subject_id IN (${placeholders})
			 ORDER BY g.created_at ASC, g.id ASC, gp.permission ASC`,
		)
		.bind(input.orgId, new Date().toISOString(), ...input.profileIds)
		.all<{
			grant_id: string
			subject_id: string
			resource_type: string
			resource_id: string
			permission: OrgPermission
		}>()
	const byGrant = new Map<string, ProfileGrantRow>()
	for (const row of result.results) {
		let grant = byGrant.get(row.grant_id)
		if (!grant) {
			grant = {
				resourceType: row.resource_type,
				resourceId: row.resource_id,
				permissions: [],
			}
			byGrant.set(row.grant_id, grant)
			const list = byProfile.get(row.subject_id) ?? []
			list.push(grant)
			byProfile.set(row.subject_id, list)
		}
		grant.permissions.push(row.permission)
	}
	return byProfile
}

/** Inserts the profile row and its snapshot grants in one batch. */
export async function insertProfile(
	db: D1Database,
	input: {
		row: ProfileRow
		grants: ReadonlyArray<RequestedProfileGrant>
	},
) {
	const { row } = input
	const statements: Array<D1PreparedStatement> = [
		db
			.prepare(
				`INSERT INTO profiles (${profileColumns})
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				row.id,
				row.org_id,
				row.owner_kind,
				row.acting_user_id,
				row.parent_profile_id,
				row.name,
				row.depth,
				row.expires_at,
				row.revoked_at,
				row.revoked_by_user_id,
				row.created_by_user_id,
				row.created_by_profile_id,
				row.created_at,
				row.updated_at,
			),
	]
	for (const grant of input.grants) {
		const grantId = `grant_${crypto.randomUUID()}`
		statements.push(
			db
				.prepare(
					`INSERT INTO grants (
						id, org_id, resource_type, resource_id, subject_type, subject_id,
						preset, created_by_user_id, created_at, updated_at, origin, expires_at
					) VALUES (?, ?, ?, ?, 'profile', ?, NULL, ?, ?, ?, 'manual', NULL)`,
				)
				.bind(
					grantId,
					row.org_id,
					grant.resourceType,
					grant.resourceId,
					row.id,
					row.created_by_user_id,
					row.created_at,
					row.created_at,
				),
		)
		for (const permission of new Set(grant.permissions)) {
			statements.push(
				db
					.prepare(
						`INSERT INTO grant_permissions (grant_id, permission) VALUES (?, ?)`,
					)
					.bind(grantId, permission),
			)
		}
	}
	await db.batch(statements)
}

/** Shorten-only: the WHERE clause refuses an extension a racing write made. */
export async function shortenProfileExpiry(
	db: D1Database,
	input: { orgId: string; profileId: string; expiresAt: string; now: string },
) {
	const result = await db
		.prepare(
			`UPDATE profiles SET expires_at = ?, updated_at = ?
			 WHERE id = ? AND org_id = ? AND revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at >= ?)`,
		)
		.bind(
			input.expiresAt,
			input.now,
			input.profileId,
			input.orgId,
			input.expiresAt,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Terminal: an already revoked row keeps its first revoke time. */
export async function revokeProfileRow(
	db: D1Database,
	input: {
		orgId: string
		profileId: string
		revokedByUserId: string
		now: string
	},
) {
	await db
		.prepare(
			`UPDATE profiles SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
			 WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
		)
		.bind(
			input.now,
			input.revokedByUserId,
			input.now,
			input.profileId,
			input.orgId,
		)
		.run()
}

/** Offboarding: soft-revoke every live profile a person acts as in an org. */
export async function revokeProfilesForMember(
	db: D1Database,
	input: { orgId: string; userId: string; now: string },
) {
	await db
		.prepare(
			`UPDATE profiles SET revoked_at = ?, revoked_by_user_id = ?, updated_at = ?
			 WHERE org_id = ? AND acting_user_id = ? AND revoked_at IS NULL`,
		)
		.bind(input.now, input.userId, input.now, input.orgId, input.userId)
		.run()
}

/**
 * Hard-deletes profiles revoked or expired more than `profilePurgeAfterDays`
 * ago, with every descendant (inactive through them), once they have no
 * children left, then the `grants` rows of profiles that
 * no longer exist (account and org purges delete profile rows directly).
 * Leaves first, so repeated runs walk a dead tree bottom-up.
 */
export async function purgeProfiles(
	db: D1Database,
	input: { now: Date },
): Promise<{ profiles: number; grants: number }> {
	const cutoff = new Date(
		input.now.getTime() - profilePurgeAfterDays * 24 * 60 * 60 * 1000,
	).toISOString()
	let profiles = 0
	for (let depth = maxProfileDepth; depth >= 1; depth--) {
		const result = await db
			.prepare(
				`WITH RECURSIVE dead(id) AS (
				   SELECT id FROM profiles
				   WHERE (revoked_at IS NOT NULL AND revoked_at < ?)
				      OR (expires_at IS NOT NULL AND expires_at < ?)
				   UNION
				   SELECT p.id FROM profiles p JOIN dead d ON p.parent_profile_id = d.id
				 )
				 DELETE FROM profiles
				 WHERE depth = ?
				   AND id IN (SELECT id FROM dead)
				   AND NOT EXISTS (
				     SELECT 1 FROM profiles child WHERE child.parent_profile_id = profiles.id
				   )`,
			)
			.bind(cutoff, cutoff, depth)
			.run()
		profiles += result.meta.changes ?? 0
	}
	const orphans = `SELECT g.id FROM grants g
		WHERE g.subject_type = 'profile'
		  AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.subject_id)`
	await db
		.prepare(`DELETE FROM grant_permissions WHERE grant_id IN (${orphans})`)
		.run()
	const grants = await db
		.prepare(`DELETE FROM grants WHERE id IN (${orphans})`)
		.run()
	return { profiles, grants: grants.meta.changes ?? 0 }
}
