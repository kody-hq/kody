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
import { z } from 'zod'
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
import { type Clock, systemClock } from '#worker/scheduled/retention/clock.ts'
import {
	d1First,
	d1Run,
	type RetentionContext,
} from '#worker/scheduled/retention/d1.ts'
import {
	nullableTimestampColumn,
	ownerIdColumn,
} from '#worker/scheduled/retention/rows.ts'
import { traced } from '#worker/scheduled/retention/telemetry.ts'

type HardPurgeOptions = { clock?: Clock; signal?: AbortSignal }

function purgeContext(env: Env, options: HardPurgeOptions): RetentionContext {
	return {
		db: env.APP_DB,
		clock: options.clock ?? systemClock,
		signal: options.signal,
	}
}

const personRelationRow = z.object({
	deleted_at: nullableTimestampColumn,
	deleting_at: nullableTimestampColumn,
})
const personalOrgRow = z.object({
	personal_org_id: z.string().nullable(),
	stable_user_id: z.string(),
})
const legacyUserRow = personalOrgRow.extend({
	deleted_at: nullableTimestampColumn,
	deleting_at: nullableTimestampColumn,
})

/**
 * How this org relates to a person account for hard-purge policy. A
 * soft-deleted person, or one still fenced by a pre-soft-delete account
 * deletion (`deleting_at` set, `deleted_at` null), owns its personal org: the
 * person purge removes it after account deletion has read the org's billing
 * identity. A live matching person (legacy personal-org soft-delete without
 * account deletion) must not lose owner inventory; block until the account is
 * deleted or the org is repaired.
 * Remove when: no org still has the legacy equal-id shape (`orgs.id` equals the person's stable user id, #3053).
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
	ctx: RetentionContext,
	orgId: OwnerId,
): Promise<PersonalOrgHardPurgeRelation> {
	const row = await d1First(ctx, {
		operation: 'hard_purge.personal_org_relation',
		sql: `SELECT deleted_at, deleting_at FROM users
			 WHERE (
			 	(personal_org_id IS NOT NULL AND TRIM(personal_org_id) != '' AND personal_org_id = ?)
			 	OR ((personal_org_id IS NULL OR TRIM(personal_org_id) = '') AND stable_user_id = ?)
			 )
			 LIMIT 1`,
		bindings: [orgId, orgId],
		row: personRelationRow,
	})
	if (!row) return 'none'
	return row.deleted_at || row.deleting_at
		? 'soft_deleted_person'
		: 'live_person'
}

export function hardPurgeOrg(
	input: { env: Env; orgId: OwnerId } & HardPurgeOptions,
): Promise<void> {
	const ctx = purgeContext(input.env, input)
	return traced(
		'retention.hard_purge.org',
		{},
		async () => {
			const relation = await personalOrgHardPurgeRelation(ctx, input.orgId)
			if (relation === 'live_person') {
				throw new PersonalOrgHardPurgeBlockedForLiveUserError(input.orgId)
			}
			if (relation === 'soft_deleted_person') {
				throw new PersonalOrgPurgesWithPersonError(input.orgId)
			}
			await wipeOrgPinnedConnections(ctx, input.env, input.orgId)
			// Team org: collect the same out-of-band keys account deletion
			// collects for this owner id, delete those objects, then delete D1
			// rows (including owner-scoped inventory without deleted_at).
			await traced(
				'retention.hard_purge.org_out_of_band',
				{},
				() =>
					purgeOwnerOutOfBandSurfaces({
						env: input.env,
						ownerId: input.orgId,
					}),
				ctx.clock,
			)
			await deleteOrgRows(ctx, {
				env: input.env,
				orgId: input.orgId,
				mode: 'team',
			})
		},
		ctx.clock,
	)
}

function wipeOrgPinnedConnections(
	ctx: RetentionContext,
	env: Env,
	orgId: OwnerId,
) {
	// Orgs soft-deleted before soft delete wiped pinned connections still have
	// them. Wipe and revoke them while the app and its client secret exist;
	// the inventory deletes any the wipe cannot see (tombstoned rows).
	return traced(
		'retention.hard_purge.wipe_pinned_connections',
		{},
		async () => {
			await wipePinnedConnectionsForOrg({
				env,
				orgId,
				audit: optionalOrgAuditWriter(env, null),
			})
		},
		ctx.clock,
	)
}

function deleteOrgRows(
	ctx: RetentionContext,
	input: { env: Env; orgId: OwnerId; mode: HardPurgeOrgMode },
) {
	return traced(
		'retention.hard_purge.delete_org_rows',
		{ 'retention.org_mode': input.mode },
		async () => {
			for (const target of hardPurgeOrgDataTargets(input.mode)) {
				const match = buildUserScopedTargetMatch({
					target,
					mcpUserId: input.orgId,
					dbUserId: -1,
				})
				const { sql, params } = buildUserScopedDeleteOrUpdateSql(match)
				await d1Run(ctx, {
					operation: 'hard_purge.delete_org_target',
					sql,
					bindings: params,
				})
			}
			const deleted = await d1Run(ctx, {
				operation: 'hard_purge.delete_org',
				sql: `DELETE FROM orgs WHERE id = ?`,
				bindings: [input.orgId],
			})
			if (deleted === 0) {
				throw new Error(`org_purge_missing_row:${input.orgId}`)
			}
			await logOrgAuditEvent({
				env: input.env,
				orgId: input.orgId,
				action: 'org.purged',
				result: 'success',
				resourceType: 'org',
				resourceId: input.orgId,
				createdAt: ctx.clock.now().toISOString(),
			})
		},
		ctx.clock,
	)
}

/**
 * Hard-delete a person account and then its personal org. Account deletion
 * reads the Stripe customer from the personal org row, so that row must still
 * exist while it cancels subscriptions and deletes the customer. Pinned
 * connections are wiped first, while the owner's OAuth apps still exist.
 */
async function purgePersonAndPersonalOrg(
	ctx: RetentionContext,
	input: {
		env: Env
		dbUserId: number
		stableUserId: OwnerId
		storageOwnerId: OwnerId
		personUserId: string
		personalOrgId: OwnerId | null
		purgeSoftDeleted?: boolean
	},
) {
	if (input.personalOrgId) {
		await wipeOrgPinnedConnections(ctx, input.env, input.personalOrgId)
	}
	await traced(
		'retention.hard_purge.redact_audit_actor',
		{},
		() =>
			redactOrgAuditActorIdsForDeletedUser({
				env: input.env,
				userId: input.stableUserId,
			}),
		ctx.clock,
	)
	const result = await traced(
		'retention.hard_purge.delete_user_account',
		{ 'retention.purge_soft_deleted': input.purgeSoftDeleted === true },
		() =>
			deleteUserAccount({
				env: input.env,
				dbUserId: input.dbUserId,
				mcpUserId: input.storageOwnerId,
				personUserId: input.personUserId,
				purgeSoftDeleted: input.purgeSoftDeleted,
			}),
		ctx.clock,
	)
	if (input.personalOrgId) {
		await deleteOrgRows(ctx, {
			env: input.env,
			orgId: input.personalOrgId,
			mode: 'personal',
		})
	}
	return result
}

async function softDeletedOrgId(
	ctx: RetentionContext,
	orgId: OwnerId,
): Promise<OwnerId | null> {
	const row = await d1First(ctx, {
		operation: 'hard_purge.soft_deleted_org',
		sql: `SELECT id FROM orgs WHERE id = ? AND deleted_at IS NOT NULL`,
		bindings: [orgId],
		row: z.object({ id: ownerIdColumn }),
	})
	return row ? orgId : null
}

export function hardPurgeSoftDeletedUser(
	input: {
		env: Env
		dbUserId: number
		stableUserId: OwnerId
	} & HardPurgeOptions,
): Promise<void> {
	const ctx = purgeContext(input.env, input)
	return traced(
		'retention.hard_purge.soft_deleted_user',
		{},
		async () => {
			const row = await d1First(ctx, {
				operation: 'hard_purge.user_personal_org',
				sql: `SELECT personal_org_id, stable_user_id FROM users WHERE id = ?`,
				bindings: [input.dbUserId],
				row: personalOrgRow,
			})
			const storageOwnerId = row
				? personalOrgIdFromUserRow(row)
				: input.stableUserId
			const personUserId = row?.stable_user_id.trim() || input.stableUserId
			await purgePersonAndPersonalOrg(ctx, {
				env: input.env,
				dbUserId: input.dbUserId,
				stableUserId: input.stableUserId,
				storageOwnerId,
				personUserId,
				personalOrgId: await softDeletedOrgId(ctx, storageOwnerId),
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
				createdAt: ctx.clock.now().toISOString(),
			})
		},
		ctx.clock,
	)
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
 * window, so this resumes the same hard deletion now:
 *
 * 1. Re-run `deleteUserAccount` on the fenced row. It reuses the existing
 *    fence, re-collects inventory, and treats storage that is already gone
 *    (404 Artifacts repos, missing KV keys) as done, so a retry is safe.
 * 2. Purge the personal org graph (the Teams backfill created one per person)
 *    after step 1 has read its billing identity.
 *
 * Idempotent: a missing users row means a prior attempt finished.
 */
export function finishLegacyUserDeletion(
	input: {
		env: Env
		dbUserId: number
		stableUserId: OwnerId
	} & HardPurgeOptions,
): Promise<{ alreadyGone: boolean }> {
	const ctx = purgeContext(input.env, input)
	return traced(
		'retention.hard_purge.finish_legacy_user_deletion',
		{},
		async (span) => {
			const row = await d1First(ctx, {
				operation: 'hard_purge.legacy_user',
				sql: `SELECT personal_org_id, stable_user_id, deleted_at, deleting_at
				 FROM users WHERE id = ?`,
				bindings: [input.dbUserId],
				row: legacyUserRow,
			})
			span.setAttribute('retention.already_gone', row === null)
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
			// Tombstone a still-live personal org first: if this attempt removes
			// the person and then fails on the org, the org lane can still purge it.
			await d1Run(ctx, {
				operation: 'hard_purge.tombstone_legacy_personal_org',
				sql: `UPDATE orgs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
				bindings: [row.deleting_at, storageOwnerId],
			})
			const result = await purgePersonAndPersonalOrg(ctx, {
				env: input.env,
				dbUserId: input.dbUserId,
				stableUserId: input.stableUserId,
				storageOwnerId,
				personUserId,
				personalOrgId: await softDeletedOrgId(ctx, storageOwnerId),
			})
			if ((result.deletedRowCounts.users ?? 0) === 0) {
				const stillThere = await d1First(ctx, {
					operation: 'hard_purge.legacy_user_present',
					sql: `SELECT 1 AS present FROM users WHERE id = ?`,
					bindings: [input.dbUserId],
					row: z.object({ present: z.number() }),
				})
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
				createdAt: ctx.clock.now().toISOString(),
			})
			return { alreadyGone: false }
		},
		ctx.clock,
	)
}
