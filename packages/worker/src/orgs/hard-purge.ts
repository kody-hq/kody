// soft-delete-read-filter: opt-out
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
} from '#worker/account/data-targets.ts'
import {
	deleteUserAccount,
	purgeOwnerOutOfBandSurfaces,
} from '#app/account-deletion.ts'
import { runD1WithRetry } from '#worker/d1-retry.ts'
import { wipePinnedConnectionsForOrg } from '#worker/integrations/pinned-connections.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import {
	type HardPurgeOrgMode,
	hardPurgeOrgDataTargets,
} from './data-targets.ts'
import {
	logOrgAuditEvent,
	optionalOrgAuditWriter,
	redactOrgAuditActorIdsForDeletedUser,
} from './org-audit.ts'
import {
	assertUserDeleteNotBlockedAsSoleOwner,
	listLiveSoleMemberTeamOrgIds,
	softDeleteOrg,
} from './soft-delete.ts'

/**
 * How this org relates to a person account for hard-purge policy. A
 * soft-deleted person, or one still fenced by a pre-soft-delete account
 * deletion (`deleting_at` set, `deleted_at` null), owns its personal org: the
 * person purge removes it after account deletion has read the org's billing
 * identity. A live matching person must not lose owner inventory; block until
 * the account is deleted or the org is repaired. The lookup uses personal_org_id
 * with a stable_user_id fallback for users whose personal_org_id is missing or
 * blank (legacy equal-id orgs, #3053).
 * Permanent: preserve personal-org billing inventory until person deletion.
 * Remove when: no users row has a missing or blank personal_org_id (drop the
 * stable_user_id fallback only).
 */
type PersonalOrgHardPurgeRelation =
	| 'soft_deleted_person'
	| 'live_person'
	| 'none'

export class PersonalOrgHardPurgeBlockedForLiveUserError extends Error {
	constructor(orgId: OwnerId) {
		super(`personal_org_hard_purge_blocked_live_user:${orgId}`)
		this.name = 'PersonalOrgHardPurgeBlockedForLiveUserError'
	}
}

export class PersonalOrgPurgesWithPersonError extends Error {
	constructor(orgId: OwnerId) {
		super(`personal_org_purges_with_person:${orgId}`)
		this.name = 'PersonalOrgPurgesWithPersonError'
	}
}

async function personalOrgHardPurgeRelation(
	db: D1Database,
	orgId: OwnerId,
): Promise<PersonalOrgHardPurgeRelation> {
	const row = await runD1WithRetry(() =>
		db
			.prepare(
				`SELECT deleted_at, deleting_at FROM users
				 WHERE (
				 	(personal_org_id IS NOT NULL AND TRIM(personal_org_id) != '' AND personal_org_id = ?)
				 	OR ((personal_org_id IS NULL OR TRIM(personal_org_id) = '') AND stable_user_id = ?)
				 )
				 LIMIT 1`,
			)
			.bind(orgId, orgId)
			.first<{ deleted_at: string | null; deleting_at: string | null }>(),
	)
	if (!row) return 'none'
	return row.deleted_at || row.deleting_at
		? 'soft_deleted_person'
		: 'live_person'
}

export async function hardPurgeOrg(input: {
	env: Env
	orgId: OwnerId
}): Promise<void> {
	const relation = await personalOrgHardPurgeRelation(
		input.env.APP_DB,
		input.orgId,
	)
	if (relation === 'live_person') {
		throw new PersonalOrgHardPurgeBlockedForLiveUserError(input.orgId)
	}
	if (relation === 'soft_deleted_person') {
		throw new PersonalOrgPurgesWithPersonError(input.orgId)
	}
	await wipeOrgPinnedConnections(input.env, input.orgId)
	// Team org: collect the same out-of-band keys account deletion collects
	// for this owner id, delete those objects, then delete D1 rows (including
	// owner-scoped inventory without deleted_at).
	await purgeOwnerOutOfBandSurfaces({
		env: input.env,
		ownerId: input.orgId,
	})
	await deleteOrgRows({ env: input.env, orgId: input.orgId, mode: 'team' })
}

export async function hardPurgeOrgIfPresent(env: Env, orgId: OwnerId) {
	try {
		await hardPurgeOrg({ env, orgId })
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith('org_purge_missing_row:')
		) {
			return
		}
		throw error
	}
}

/**
 * Tombstoned organizations this person was the only Owner of, other than
 * their personal org. Nobody is left to restore them once the person is
 * hard-deleted, so the person's hard delete purges them.
 */
export async function listTombstonedSoleOwnedOrgIds(
	db: D1Database,
	userId: string,
	personalOrgId: string,
) {
	const rows = await db
		.prepare(
			`SELECT o.id AS id
			 FROM orgs o
			 INNER JOIN org_memberships m
			   ON m.org_id = o.id AND m.user_id = ? AND m.role = 'owner'
			 WHERE o.deleted_at IS NOT NULL
			   AND o.id != ?
			   AND NOT EXISTS (
			     SELECT 1 FROM org_memberships other
			     WHERE other.org_id = o.id
			       AND other.role = 'owner'
			       AND other.user_id != ?
			   )`,
		)
		.bind(userId, personalOrgId, userId)
		.all<{ id: string }>()
	return (rows.results ?? []).map((row) => row.id)
}

/**
 * Team-org step of every hard delete of a person who was not soft-deleted
 * first (unverified-account purge, guest purge, guest merge, and the
 * `deleting_at` retry). It applies the account-deletion rules of
 * `softDeleteUserAccount` before `deleteUserAccount` removes the person's
 * memberships:
 *
 * - The only Owner of a team org that still has other members blocks the
 *   deletion (`UserDeleteBlockedSoleOwnerError`). Nothing is changed.
 * - A team org whose only member is this person is tombstoned and then purged
 *   now, because these paths have no restore window.
 * - Shared orgs with another Owner stay; `deleteUserAccount` removes the
 *   membership.
 *
 * Safe to retry: an org tombstoned by a failed attempt is purged next time.
 */
export async function purgeSoleMemberTeamOrgsForPersonHardDelete(input: {
	env: Env
	personUserId: OwnerId
	personalOrgId: OwnerId
}): Promise<{ purgedOrgIds: Array<string> }> {
	const db = input.env.APP_DB
	await assertUserDeleteNotBlockedAsSoleOwner({
		db,
		userId: input.personUserId,
	})
	const liveOrgIds = await listLiveSoleMemberTeamOrgIds({
		db,
		userId: input.personUserId,
		personalOrgId: input.personalOrgId,
	})
	for (const orgId of liveOrgIds) {
		await softDeleteOrg({
			env: input.env,
			orgId,
			actorUserId: input.personUserId,
		})
	}
	// Orgs a failed attempt already tombstoned. An org that ever had another
	// member keeps its restore window and is left to the org purge lane.
	const tombstoned = await db
		.prepare(
			`SELECT o.id AS id
			 FROM orgs o
			 INNER JOIN org_memberships m ON m.org_id = o.id AND m.user_id = ?
			 WHERE o.deleted_at IS NOT NULL
			   AND o.id != ?
			   AND NOT EXISTS (
			     SELECT 1 FROM org_memberships other
			     WHERE other.org_id = o.id AND other.user_id != ?
			   )`,
		)
		.bind(input.personUserId, input.personalOrgId, input.personUserId)
		.all<{ id: OwnerId }>()
	const purgedOrgIds = [
		...new Set([
			...liveOrgIds,
			...(tombstoned.results ?? []).map((row) => row.id),
		]),
	]
	for (const orgId of purgedOrgIds) {
		await hardPurgeOrgIfPresent(input.env, orgId)
	}
	return { purgedOrgIds }
}

async function wipeOrgPinnedConnections(env: Env, orgId: OwnerId) {
	// Orgs soft-deleted before soft delete wiped pinned connections still have
	// them. Wipe and revoke them while the app and its client secret exist;
	// the inventory deletes any the wipe cannot see (tombstoned rows).
	await wipePinnedConnectionsForOrg({
		env,
		orgId,
		audit: optionalOrgAuditWriter(env, null),
	})
}

async function deleteOrgRows(input: {
	env: Env
	orgId: OwnerId
	mode: HardPurgeOrgMode
}) {
	const db = input.env.APP_DB
	for (const target of hardPurgeOrgDataTargets(input.mode)) {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: input.orgId,
			dbUserId: -1,
		})
		const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
		await runD1WithRetry(() =>
			db
				.prepare(sql)
				.bind(...params)
				.run(),
		)
	}
	const orgDelete = await runD1WithRetry(() =>
		db.prepare(`DELETE FROM orgs WHERE id = ?`).bind(input.orgId).run(),
	)
	if ((orgDelete.meta.changes ?? 0) === 0) {
		throw new Error(`org_purge_missing_row:${input.orgId}`)
	}
	await logOrgAuditEvent({
		env: input.env,
		orgId: input.orgId,
		action: 'org.purged',
		result: 'success',
		resourceType: 'org',
		resourceId: input.orgId,
	})
}

/**
 * Hard-delete a person account and then its personal org. Account deletion
 * reads the Stripe customer from the personal org row, so that row must still
 * exist while it cancels subscriptions and deletes the customer. Pinned
 * connections are wiped first, while the owner's OAuth apps still exist.
 */
async function purgePersonAndPersonalOrg(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
	storageOwnerId: OwnerId
	personUserId: string
	personalOrgId: OwnerId | null
	purgeSoftDeleted?: boolean
}) {
	if (input.personalOrgId) {
		await wipeOrgPinnedConnections(input.env, input.personalOrgId)
	}
	await redactOrgAuditActorIdsForDeletedUser({
		env: input.env,
		userId: input.stableUserId,
	})
	const result = await deleteUserAccount({
		env: input.env,
		dbUserId: input.dbUserId,
		mcpUserId: input.storageOwnerId,
		personUserId: input.personUserId,
		purgeSoftDeleted: input.purgeSoftDeleted,
	})
	if (input.personalOrgId) {
		await deleteOrgRows({
			env: input.env,
			orgId: input.personalOrgId,
			mode: 'personal',
		})
	}
	return result
}

/**
 * Hard-delete a live (never soft-deleted) person with every org that would
 * otherwise be left without members: sole-member team orgs first, then the
 * person, then the personal org row. Use this instead of calling
 * `deleteUserAccount` directly; see
 * docs/contributing/architecture/data-storage/account-lifecycle.md.
 *
 * Throws `UserDeleteBlockedSoleOwnerError` before changing anything when the
 * person is the only Owner of a team org that still has other members.
 */
export async function hardDeleteLivePersonWithOrgs(input: {
	env: Env
	dbUserId: number
	/** The person's `users.stable_user_id`. */
	personUserId: string
	personalOrgId: OwnerId
	keepOAuthGrants?: boolean
}) {
	await purgeSoleMemberTeamOrgsForPersonHardDelete({
		env: input.env,
		personUserId: input.personUserId as OwnerId,
		personalOrgId: input.personalOrgId,
	})
	const result = await deleteUserAccount({
		env: input.env,
		dbUserId: input.dbUserId,
		mcpUserId: input.personalOrgId,
		personUserId: input.personUserId,
		keepOAuthGrants: input.keepOAuthGrants,
	})
	// Account deletion read the Stripe customer from this row, so it goes
	// last. Tombstoned first: if the row delete fails, the org lane purges it.
	const db = input.env.APP_DB
	const tombstoned = await runD1WithRetry(() =>
		db
			.prepare(
				`UPDATE orgs SET deleted_at = ?
				 WHERE id = ? AND deleted_at IS NULL
				   AND NOT EXISTS (
				     SELECT 1 FROM users u
				     WHERE COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) = orgs.id
				   )`,
			)
			.bind(new Date().toISOString(), input.personalOrgId)
			.run(),
	)
	if ((tombstoned.meta.changes ?? 0) === 1) {
		await deleteOrgRows({
			env: input.env,
			orgId: input.personalOrgId,
			mode: 'personal',
		})
	}
	return result
}

async function softDeletedOrgId(
	db: D1Database,
	orgId: OwnerId,
): Promise<OwnerId | null> {
	const row = await runD1WithRetry(() =>
		db
			.prepare(`SELECT id FROM orgs WHERE id = ? AND deleted_at IS NOT NULL`)
			.bind(orgId)
			.first<{ id: string }>(),
	)
	return row ? orgId : null
}

export async function hardPurgeSoftDeletedUser(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
}): Promise<void> {
	const personalOrgRow = await runD1WithRetry(() =>
		input.env.APP_DB.prepare(
			`SELECT personal_org_id, stable_user_id FROM users WHERE id = ?`,
		)
			.bind(input.dbUserId)
			.first<{ personal_org_id: string | null; stable_user_id: string }>(),
	)
	const storageOwnerId = personalOrgRow
		? personalOrgIdFromUserRow(personalOrgRow)
		: input.stableUserId
	const personUserId =
		personalOrgRow?.stable_user_id?.trim() || input.stableUserId
	await purgePersonAndPersonalOrg({
		env: input.env,
		dbUserId: input.dbUserId,
		stableUserId: input.stableUserId,
		storageOwnerId,
		personUserId,
		personalOrgId: await softDeletedOrgId(input.env.APP_DB, storageOwnerId),
		purgeSoftDeleted: true,
	})
	await logOrgAuditEvent({
		env: input.env,
		orgId: storageOwnerId,
		action: 'user.purged',
		result: 'success',
		resourceType: 'user',
		resourceId: input.stableUserId,
		targetUserId: input.stableUserId,
	})
}

export class LegacyUserDeletionNotPendingError extends Error {
	constructor(stableUserId: OwnerId, reason: string) {
		super(`legacy_user_deletion_not_pending:${reason}:${stableUserId}`)
		this.name = 'LegacyUserDeletionNotPendingError'
	}
}

/**
 * Finish an account deletion that started before soft delete existed.
 *
 * That flow fenced the account with `deleting_at`, removed outside storage,
 * and deleted D1 rows last. When any step warned it stopped and left
 * `deleting_at` set with `deleted_at` null, meaning "retry later". Nothing
 * retried it. The owner asked for deletion and was never offered a restore
 * window. The retry resumes that hard deletion:
 *
 * 1. Tombstone the personal org so the org lane can finish a partial purge.
 * 2. Re-run `deleteUserAccount` on the fenced row. It reuses the existing
 *    fence, re-collects inventory, and treats storage that is already gone
 *    (404 Artifacts repos, missing KV keys) as done, so a retry is safe.
 * 3. Purge the personal org graph (the Teams backfill created one per person)
 *    after step 2 has read its billing identity.
 *
 * Idempotent: a missing users row means a prior attempt deleted the person. A
 * personal org left behind by a failed graph purge stays tombstoned for the
 * org lane.
 *
 * Permanent: guest purge also uses this to retry a fenced guest deletion, so
 * it stays after the legacy backlog is gone.
 */
export async function finishLegacyUserDeletion(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
}): Promise<{ alreadyGone: boolean }> {
	const row = await runD1WithRetry(() =>
		input.env.APP_DB.prepare(
			`SELECT personal_org_id, stable_user_id, deleted_at, deleting_at
			 FROM users WHERE id = ?`,
		)
			.bind(input.dbUserId)
			.first<{
				personal_org_id: string | null
				stable_user_id: string
				deleted_at: string | null
				deleting_at: string | null
			}>(),
	)
	if (!row) return { alreadyGone: true }
	if (row.stable_user_id !== input.stableUserId) {
		throw new LegacyUserDeletionNotPendingError(
			input.stableUserId,
			'id_mismatch',
		)
	}
	if (row.deleted_at) {
		// Soft-deleted rows belong to the regular purge lane and its window.
		throw new LegacyUserDeletionNotPendingError(
			input.stableUserId,
			'soft_deleted',
		)
	}
	if (!row.deleting_at) {
		throw new LegacyUserDeletionNotPendingError(input.stableUserId, 'live')
	}
	const storageOwnerId = personalOrgIdFromUserRow(row)
	const personUserId = row.stable_user_id.trim() || input.stableUserId
	await purgeSoleMemberTeamOrgsForPersonHardDelete({
		env: input.env,
		personUserId: input.stableUserId,
		personalOrgId: storageOwnerId,
	})
	// Tombstone a still-live personal org first: if this attempt removes the
	// person and then fails on the org, the org lane can still purge it.
	const deletingAt = row.deleting_at
	await runD1WithRetry(() =>
		input.env.APP_DB.prepare(
			`UPDATE orgs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(deletingAt, storageOwnerId)
			.run(),
	)
	const result = await purgePersonAndPersonalOrg({
		env: input.env,
		dbUserId: input.dbUserId,
		stableUserId: input.stableUserId,
		storageOwnerId,
		personUserId,
		personalOrgId: await softDeletedOrgId(input.env.APP_DB, storageOwnerId),
	})
	if ((result.deletedRowCounts.users ?? 0) === 0) {
		const stillThere = await runD1WithRetry(() =>
			input.env.APP_DB.prepare(`SELECT 1 AS present FROM users WHERE id = ?`)
				.bind(input.dbUserId)
				.first<{ present: number }>(),
		)
		if (stillThere) {
			throw new Error(
				`legacy_user_deletion_row_not_removed:${input.stableUserId}`,
			)
		}
	}
	await logOrgAuditEvent({
		env: input.env,
		orgId: storageOwnerId,
		action: 'user.purged',
		result: 'success',
		resourceType: 'user',
		resourceId: input.stableUserId,
		targetUserId: input.stableUserId,
		detailsJson: JSON.stringify({ lane: 'legacy_deletion_finish' }),
	})
	return { alreadyGone: false }
}
