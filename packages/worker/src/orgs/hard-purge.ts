// soft-delete-read-filter: opt-out
import { createActor, createAsyncLogic, toPromise } from 'xstate'
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
	orgHardPurgeState,
	personHardPurgeState,
	type PersonalOrgHardPurgeRelation,
	type PersonHardPurgeOutput,
	type PersonPurgeMode,
	type PersonPurgeRow,
	type PersonPurgeTarget,
} from './hard-purge-state.ts'

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

const orgPurgeActors = (env: Env) => ({
	wipePinnedConnections: createAsyncLogic<void, { orgId: OwnerId }>({
		run: ({ input }) => wipeOrgPinnedConnections(env, input.orgId),
	}),
	deleteOrgData: createAsyncLogic<
		void,
		{ orgId: OwnerId; mode: HardPurgeOrgMode }
	>({ run: ({ input }) => deleteOrgData({ env, ...input }) }),
	auditOrgPurged: createAsyncLogic<void, { orgId: OwnerId }>({
		run: ({ input }) =>
			logOrgAuditEvent({
				env,
				orgId: input.orgId,
				action: 'org.purged',
				result: 'success',
				resourceType: 'org',
				resourceId: input.orgId,
			}),
	}),
})

export async function hardPurgeOrg(input: {
	env: Env
	orgId: OwnerId
}): Promise<void> {
	const workflow = orgHardPurgeState.provide({
		actors: {
			...orgPurgeActors(input.env),
			readPersonalOrgRelation: createAsyncLogic<
				PersonalOrgHardPurgeRelation,
				{ orgId: OwnerId }
			>({
				run: () => personalOrgHardPurgeRelation(input.env.APP_DB, input.orgId),
			}),
			// Team org: collect the same out-of-band keys account deletion collects
			// for this owner id, delete those objects, then delete D1 rows (including
			// owner-scoped inventory without deleted_at).
			purgeOutOfBandSurfaces: createAsyncLogic<void, { orgId: OwnerId }>({
				run: async () => {
					await purgeOwnerOutOfBandSurfaces({
						env: input.env,
						ownerId: input.orgId,
					})
				},
			}),
		},
	})
	const output = await toPromise(
		createActor(workflow, { input: { orgId: input.orgId } }).start(),
	)
	if (output.status === 'blocked_live_person')
		throw new PersonalOrgHardPurgeBlockedForLiveUserError(input.orgId)
	if (output.status === 'purges_with_person')
		throw new PersonalOrgPurgesWithPersonError(input.orgId)
	if (output.status === 'failed') throw output.error
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

async function deleteOrgData(input: {
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
}

/**
 * Hard-delete a person account and then its personal org. Account deletion
 * reads the Stripe customer from the personal org row, so that row must still
 * exist while it cancels subscriptions and deletes the customer. Pinned
 * connections are wiped first, while the owner's OAuth apps still exist.
 */
async function purgePerson(input: {
	env: Env
	mode: PersonPurgeMode
	dbUserId: number
	stableUserId: OwnerId
}): Promise<PersonHardPurgeOutput> {
	const env = input.env
	const workflow = personHardPurgeState.provide({
		actors: {
			...orgPurgeActors(env),
			readPerson: createAsyncLogic<PersonPurgeRow | null, { dbUserId: number }>(
				{
					run: async () => {
						const row = await runD1WithRetry(() =>
							env.APP_DB.prepare(
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
						if (!row) return null
						return {
							stableUserId: row.stable_user_id,
							storageOwnerId: personalOrgIdFromUserRow(row),
							personUserId: row.stable_user_id?.trim() || input.stableUserId,
							deletedAt: row.deleted_at,
							deletingAt: row.deleting_at,
						}
					},
				},
			),
			// Tombstone a still-live personal org first: if this attempt removes the
			// person and then fails on the org, the org lane can still purge it.
			tombstonePersonalOrg: createAsyncLogic<
				void,
				{ orgId: OwnerId; deletedAt: string }
			>({
				run: async ({ input: org }) => {
					await runD1WithRetry(() =>
						env.APP_DB.prepare(
							`UPDATE orgs SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
						)
							.bind(org.deletedAt, org.orgId)
							.run(),
					)
				},
			}),
			resolveSoftDeletedOrg: createAsyncLogic<
				OwnerId | null,
				{ orgId: OwnerId }
			>({ run: ({ input: org }) => softDeletedOrgId(env.APP_DB, org.orgId) }),
			redactAuditActors: createAsyncLogic<void, { userId: OwnerId }>({
				run: ({ input: actor }) =>
					redactOrgAuditActorIdsForDeletedUser({ env, userId: actor.userId }),
			}),
			deleteAccount: createAsyncLogic<number, PersonPurgeTarget>({
				run: async ({ input: person }) => {
					const result = await deleteUserAccount({
						env,
						dbUserId: person.dbUserId,
						mcpUserId: person.storageOwnerId,
						personUserId: person.personUserId,
						purgeSoftDeleted: person.mode === 'soft_deleted' ? true : undefined,
					})
					return result.deletedRowCounts.users ?? 0
				},
			}),
			readUserRowPresent: createAsyncLogic<boolean, { dbUserId: number }>({
				run: async () => {
					const stillThere = await runD1WithRetry(() =>
						env.APP_DB.prepare(`SELECT 1 AS present FROM users WHERE id = ?`)
							.bind(input.dbUserId)
							.first<{ present: number }>(),
					)
					return Boolean(stillThere)
				},
			}),
			auditUserPurged: createAsyncLogic<void, PersonPurgeTarget>({
				run: ({ input: person }) =>
					logOrgAuditEvent({
						env,
						orgId: person.storageOwnerId,
						action: 'user.purged',
						result: 'success',
						resourceType: 'user',
						resourceId: person.stableUserId,
						targetUserId: person.stableUserId,
						...(person.mode === 'legacy'
							? {
									detailsJson: JSON.stringify({
										lane: 'legacy_deletion_finish',
									}),
								}
							: {}),
					}),
			}),
		},
	})
	return toPromise(
		createActor(workflow, {
			input: {
				mode: input.mode,
				dbUserId: input.dbUserId,
				stableUserId: input.stableUserId,
			},
		}).start(),
	)
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
	const output = await purgePerson({ ...input, mode: 'soft_deleted' })
	if (output.status === 'failed') throw output.error
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
 */
export async function finishLegacyUserDeletion(input: {
	env: Env
	dbUserId: number
	stableUserId: OwnerId
}): Promise<{ alreadyGone: boolean }> {
	const output = await purgePerson({ ...input, mode: 'legacy' })
	if (output.status === 'already_gone') return { alreadyGone: true }
	if (output.status === 'not_pending')
		throw new LegacyUserDeletionNotPendingError(
			input.stableUserId,
			output.reason,
		)
	if (output.status === 'row_not_removed')
		throw new Error(
			`legacy_user_deletion_row_not_removed:${input.stableUserId}`,
		)
	if (output.status === 'failed') throw output.error
	return { alreadyGone: false }
}
