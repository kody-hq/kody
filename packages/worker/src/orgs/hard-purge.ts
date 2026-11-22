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
