// soft-delete-read-filter: opt-out
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { Effect, Option, Schema } from 'effect'
import {
	buildUserScopedDeleteOrUpdateSql,
	buildUserScopedTargetMatch,
} from '#worker/account/data-targets.ts'
import {
	deleteUserAccountEffect,
	purgeOwnerOutOfBandSurfacesEffect,
} from '#app/account-deletion.ts'
import { wipePinnedConnectionsForOrg } from '#worker/integrations/pinned-connections.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { AuditLog } from '#worker/effect/audit.ts'
import { type Bound, D1, retryTransientD1, sql } from '#worker/effect/d1.ts'
import { outbound } from '#worker/effect/outbound.ts'
import { runSlicePromise } from '#worker/effect/slice.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import {
	type HardPurgeOrgMode,
	hardPurgeOrgDataTargets,
} from './data-targets.ts'
import {
	optionalOrgAuditWriter,
	redactOrgAuditActorIdsForDeletedUser,
} from './org-audit.ts'

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

export class PersonalOrgHardPurgeBlockedForLiveUserError extends Schema.TaggedError<PersonalOrgHardPurgeBlockedForLiveUserError>()(
	'PersonalOrgHardPurgeBlockedForLiveUserError',
	{ message: Schema.String },
) {
	constructor(orgId: OwnerId) {
		super({ message: `personal_org_hard_purge_blocked_live_user:${orgId}` })
	}
}

export class PersonalOrgPurgesWithPersonError extends Schema.TaggedError<PersonalOrgPurgesWithPersonError>()(
	'PersonalOrgPurgesWithPersonError',
	{ message: Schema.String },
) {
	constructor(orgId: OwnerId) {
		super({ message: `personal_org_purges_with_person:${orgId}` })
	}
}

export class LegacyUserDeletionNotPendingError extends Schema.TaggedError<LegacyUserDeletionNotPendingError>()(
	'LegacyUserDeletionNotPendingError',
	{ message: Schema.String },
) {
	constructor(stableUserId: OwnerId, reason: string) {
		super({ message: `legacy_user_deletion_not_pending:${reason}:${stableUserId}` })
	}
}

/** A hard purge ran but a row it must remove is still there (or was already gone). */
export class HardPurgeRowError extends Schema.TaggedError<HardPurgeRowError>()(
	'HardPurgeRowError',
	{ message: Schema.String },
) {}

const RelationRow = Schema.Struct({
	deleted_at: Schema.NullOr(Schema.String),
	deleting_at: Schema.NullOr(Schema.String),
})
const IdRow = Schema.Struct({ id: Schema.String })
const PersonalOrgRow = Schema.Struct({
	personal_org_id: Schema.NullOr(Schema.String),
	stable_user_id: Schema.String,
})
const LegacyUserRow = Schema.Struct({
	personal_org_id: Schema.NullOr(Schema.String),
	stable_user_id: Schema.String,
	deleted_at: Schema.NullOr(Schema.String),
	deleting_at: Schema.NullOr(Schema.String),
})
const PresentRow = Schema.Struct({ present: Schema.Number })

const personalOrgHardPurgeRelation = Effect.fn('HardPurge.personalOrgRelation')(
	function* (orgId: OwnerId) {
		const db = yield* D1
		const row = yield* retryTransientD1(
			db.first(
				'hard_purge.personal_org_relation',
				RelationRow,
				sql(
					`SELECT deleted_at, deleting_at FROM users
					 WHERE (
					 	(personal_org_id IS NOT NULL AND TRIM(personal_org_id) != '' AND personal_org_id = ?)
					 	OR ((personal_org_id IS NULL OR TRIM(personal_org_id) = '') AND stable_user_id = ?)
					 )
					 LIMIT 1`,
					orgId,
					orgId,
				),
			),
		)
		const relation: PersonalOrgHardPurgeRelation = Option.match(row, {
			onNone: () => 'none',
			onSome: (person) =>
				person.deleted_at || person.deleting_at
					? 'soft_deleted_person'
					: 'live_person',
		})
		return relation
	},
)

/**
 * Orgs soft-deleted before soft delete wiped pinned connections still have
 * them. Wipe and revoke them while the app and its client secret exist; the
 * inventory deletes any the wipe cannot see (tombstoned rows).
 */
const wipeOrgPinnedConnections = Effect.fn('HardPurge.wipeOrgPinnedConnections')(
	function* (orgId: OwnerId) {
		const env = yield* WorkerEnv
		yield* outbound('pinned_connections.wipeForOrg', () =>
			wipePinnedConnectionsForOrg({
				env,
				orgId,
				audit: optionalOrgAuditWriter(env, null),
			}),
		)
	},
)

const deleteOrgRows = Effect.fn('HardPurge.deleteOrgRows')(function* (
	orgId: OwnerId,
	mode: HardPurgeOrgMode,
) {
	const db = yield* D1
	const audit = yield* AuditLog
	for (const target of hardPurgeOrgDataTargets(mode)) {
		const match = buildUserScopedTargetMatch({
			target,
			mcpUserId: orgId,
			dbUserId: -1,
		})
		const statement = buildUserScopedDeleteOrUpdateSql(match)
		yield* retryTransientD1(
			db.run(
				`hard_purge.delete.${match.table}`,
				sql(statement.sql, ...(statement.params as Array<Bound>)),
			),
		)
	}
	const { changes } = yield* retryTransientD1(
		db.run('hard_purge.delete_org', sql(`DELETE FROM orgs WHERE id = ?`, orgId)),
	)
	if (changes === 0) {
		return yield* new HardPurgeRowError({
			message: `org_purge_missing_row:${orgId}`,
		})
	}
	yield* audit.recordOrg({
		orgId,
		action: 'org.purged',
		result: 'success',
		resourceType: 'org',
		resourceId: orgId,
	})
	yield* Effect.logDebug('org rows purged', { mode })
})

/**
 * Hard-delete a team org: refuse personal orgs (they purge with their
 * person), wipe pinned connections, delete the owner's out-of-band surfaces,
 * then the owner-scoped D1 rows.
 */
export const hardPurgeOrgEffect = Effect.fn('HardPurge.hardPurgeOrg')(function* (
	orgId: OwnerId,
) {
	yield* Effect.annotateCurrentSpan('kody.org_id', orgId)
	const relation = yield* personalOrgHardPurgeRelation(orgId)
	if (relation === 'live_person') {
		return yield* new PersonalOrgHardPurgeBlockedForLiveUserError(orgId)
	}
	if (relation === 'soft_deleted_person') {
		return yield* new PersonalOrgPurgesWithPersonError(orgId)
	}
	yield* wipeOrgPinnedConnections(orgId)
	yield* purgeOwnerOutOfBandSurfacesEffect({ ownerId: orgId })
	yield* deleteOrgRows(orgId, 'team')
	yield* Effect.logInfo('org hard purged')
})

/**
 * Hard-delete a person account and then its personal org. Account deletion
 * reads the Stripe customer from the personal org row, so that row must still
 * exist while it cancels subscriptions and deletes the customer. Pinned
 * connections are wiped first, while the owner's OAuth apps still exist.
 */
const purgePersonAndPersonalOrg = Effect.fn('HardPurge.purgePersonAndPersonalOrg')(
	function* (input: {
		readonly dbUserId: number
		readonly stableUserId: OwnerId
		readonly storageOwnerId: OwnerId
		readonly personUserId: string
		readonly personalOrgId: Option.Option<OwnerId>
		readonly purgeSoftDeleted?: boolean
	}) {
		const env = yield* WorkerEnv
		if (Option.isSome(input.personalOrgId)) {
			yield* wipeOrgPinnedConnections(input.personalOrgId.value)
		}
		yield* outbound('org_audit.redactActorIdsForDeletedUser', () =>
			redactOrgAuditActorIdsForDeletedUser({ env, userId: input.stableUserId }),
		)
		const result = yield* deleteUserAccountEffect({
			dbUserId: input.dbUserId,
			mcpUserId: input.storageOwnerId,
			personUserId: input.personUserId,
			purgeSoftDeleted: input.purgeSoftDeleted,
		})
		if (Option.isSome(input.personalOrgId)) {
			yield* deleteOrgRows(input.personalOrgId.value, 'personal')
		}
		return result
	},
)

const softDeletedOrgId = Effect.fn('HardPurge.softDeletedOrgId')(function* (
	orgId: OwnerId,
) {
	const db = yield* D1
	const row = yield* retryTransientD1(
		db.first(
			'hard_purge.soft_deleted_org',
			IdRow,
			sql(`SELECT id FROM orgs WHERE id = ? AND deleted_at IS NOT NULL`, orgId),
		),
	)
	return Option.as(row, orgId)
})

/** Hard-delete a soft-deleted person and, in the same pass, their personal org. */
export const hardPurgeSoftDeletedUserEffect = Effect.fn(
	'HardPurge.hardPurgeSoftDeletedUser',
)(function* (input: { readonly dbUserId: number; readonly stableUserId: OwnerId }) {
	const db = yield* D1
	const audit = yield* AuditLog
	yield* Effect.annotateCurrentSpan('kody.user_id', input.stableUserId)
	const personalOrgRow = yield* retryTransientD1(
		db.first(
			'hard_purge.user_personal_org',
			PersonalOrgRow,
			sql(
				`SELECT personal_org_id, stable_user_id FROM users WHERE id = ?`,
				input.dbUserId,
			),
		),
	)
	const storageOwnerId = Option.match(personalOrgRow, {
		onNone: () => input.stableUserId,
		onSome: personalOrgIdFromUserRow,
	})
	const personUserId =
		Option.getOrUndefined(personalOrgRow)?.stable_user_id.trim() ||
		input.stableUserId
	yield* purgePersonAndPersonalOrg({
		dbUserId: input.dbUserId,
		stableUserId: input.stableUserId,
		storageOwnerId,
		personUserId,
		personalOrgId: yield* softDeletedOrgId(storageOwnerId),
		purgeSoftDeleted: true,
	})
	yield* audit.recordOrg({
		orgId: storageOwnerId,
		action: 'user.purged',
		result: 'success',
		resourceType: 'user',
		resourceId: input.stableUserId,
		targetUserId: input.stableUserId,
	})
	yield* Effect.logInfo('soft-deleted user hard purged')
})

/**
 * Finish an account deletion that started before soft delete existed.
 *
 * That flow fenced the account with `deleting_at`, removed outside storage,
 * and deleted D1 rows last. When any step warned it stopped and left
 * `deleting_at` set with `deleted_at` null, meaning "retry later". Nothing
 * retried it. The owner asked for deletion and was never offered a restore
 * window, so this resumes the same hard deletion now:
 *
 * 1. Re-run account deletion on the fenced row. It reuses the existing
 *    fence, re-collects inventory, and treats storage that is already gone
 *    as done, so a retry is safe.
 * 2. Purge the personal org graph after step 1 has read its billing identity.
 *
 * Idempotent: a missing users row means a prior attempt finished.
 */
export const finishLegacyUserDeletionEffect = Effect.fn(
	'HardPurge.finishLegacyUserDeletion',
)(function* (input: { readonly dbUserId: number; readonly stableUserId: OwnerId }) {
	const db = yield* D1
	const audit = yield* AuditLog
	yield* Effect.annotateCurrentSpan('kody.user_id', input.stableUserId)
	const found = yield* retryTransientD1(
		db.first(
			'hard_purge.legacy_user',
			LegacyUserRow,
			sql(
				`SELECT personal_org_id, stable_user_id, deleted_at, deleting_at
				 FROM users WHERE id = ?`,
				input.dbUserId,
			),
		),
	)
	if (Option.isNone(found)) return { alreadyGone: true }
	const row = found.value
	if (row.stable_user_id !== input.stableUserId) {
		return yield* new LegacyUserDeletionNotPendingError(
			input.stableUserId,
			'id_mismatch',
		)
	}
	if (row.deleted_at) {
		// Soft-deleted rows belong to the regular purge lane and its window.
		return yield* new LegacyUserDeletionNotPendingError(
			input.stableUserId,
			'soft_deleted',
		)
	}
	if (!row.deleting_at) {
		return yield* new LegacyUserDeletionNotPendingError(
			input.stableUserId,
			'live',
		)
	}
	const storageOwnerId = personalOrgIdFromUserRow(row)
	const personUserId = row.stable_user_id.trim() || input.stableUserId
	// Tombstone a still-live personal org first: if this attempt removes the
	// person and then fails on the org, the org lane can still purge it.
	yield* retryTransientD1(
		db.run(
			'hard_purge.tombstone_personal_org',
			sql(
				`UPDATE orgs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
				row.deleting_at,
				storageOwnerId,
			),
		),
	)
	const result = yield* purgePersonAndPersonalOrg({
		dbUserId: input.dbUserId,
		stableUserId: input.stableUserId,
		storageOwnerId,
		personUserId,
		personalOrgId: yield* softDeletedOrgId(storageOwnerId),
	})
	if ((result.deletedRowCounts.users ?? 0) === 0) {
		const stillThere = yield* retryTransientD1(
			db.first(
				'hard_purge.legacy_user_present',
				PresentRow,
				sql(`SELECT 1 AS present FROM users WHERE id = ?`, input.dbUserId),
			),
		)
		if (Option.isSome(stillThere)) {
			return yield* new HardPurgeRowError({
				message: `legacy_user_deletion_row_not_removed:${input.stableUserId}`,
			})
		}
	}
	yield* audit.recordOrg({
		orgId: storageOwnerId,
		action: 'user.purged',
		result: 'success',
		resourceType: 'user',
		resourceId: input.stableUserId,
		targetUserId: input.stableUserId,
		detailsJson: JSON.stringify({ lane: 'legacy_deletion_finish' }),
	})
	yield* Effect.logInfo('legacy user deletion finished')
	return { alreadyGone: false }
})

export function hardPurgeOrg(input: { env: Env; orgId: OwnerId }): Promise<void> {
	return runSlicePromise(input.env, hardPurgeOrgEffect(input.orgId))
}

export function hardPurgeSoftDeletedUser(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
}): Promise<void> {
	const { env, ...rest } = input
	return runSlicePromise(env, hardPurgeSoftDeletedUserEffect(rest))
}

export function finishLegacyUserDeletion(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
}): Promise<{ alreadyGone: boolean }> {
	const { env, ...rest } = input
	return runSlicePromise(env, finishLegacyUserDeletionEffect(rest))
}
