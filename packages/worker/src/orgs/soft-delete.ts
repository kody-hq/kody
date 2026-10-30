/**
 * soft-delete-read-filter: opt-out
 *
 * Soft-delete and restore must read and update tombstoned rows.
 */

import {
	isReleasedAccountEmail,
	isReleasedOrgSlug,
} from '#worker/identity/deleted-account-identity-release.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import {
	AccountDeletionWritersActiveError,
	abortOrgDeleting,
	clearUserMeterDeletionTombstone,
	markOrgDeleting,
} from '#worker/account/deletion-state.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	isWithinSoftDeleteRestoreWindow,
	softDeletePurgeCutoffIso,
} from '#worker/soft-delete/window.ts'
import {
	logOrgAuditEvent,
	orgAuditWriterForPerson,
} from '#worker/orgs/org-audit.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { syncJobManagerAlarm } from '#worker/jobs/manager-client.ts'
import {
	orgOwnedBucketChildSoftDeleteTables,
	orgOwnedUserIdRestoreTables,
	orgOwnedUserIdSoftDeleteTables,
} from '#worker/orgs/data-targets.ts'
import { cancelKodySubscriptionsForSoftDelete } from '#worker/billing/soft-delete-billing.ts'
import { refreshStripePlanForOrg } from '#worker/billing/subscription-sync.ts'
import {
	FreeOrgLimitError,
	MAX_FREE_ORGS_PER_USER,
	countLiveFreeOwnedOrgs,
	effectiveFreeOrgSql,
	isPaidOrg,
} from '#worker/orgs/billing.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { onMemberSoftRemoved } from '#worker/orgs/member-offboarding.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { type OAuthGrantHelpers } from '#worker/oauth-grants.ts'
import { revokeOAuthGrantsForOrg } from '#worker/orgs/offboarding.ts'

export { AccountDeletionWritersActiveError }

export class OrgRestoreWindowExpiredError extends Error {
	constructor() {
		super('restore_window_expired')
		this.name = 'OrgRestoreWindowExpiredError'
	}
}

/**
 * Personal orgs are the account identity. Delete them only via account
 * deletion ({@link softDeleteUserAccount}), which tombstones the person first
 * so hard purge can defer owner inventory to the following user purge.
 */
export class PersonalOrgDeleteRequiresAccountDeletionError extends Error {
	constructor() {
		super('personal_org_delete_requires_account_deletion')
		this.name = 'PersonalOrgDeleteRequiresAccountDeletionError'
	}
}

export class UserDeleteBlockedSoleOwnerError extends Error {
	readonly blockers: Array<{ orgId: OwnerId; orgSlug: string }>
	constructor(blockers: Array<{ orgId: OwnerId; orgSlug: string }>) {
		const names = blockers.map((b) => `@${b.orgSlug}`).join(', ')
		super(`user_deletion_blocked_sole_owner:${names}`)
		this.name = 'UserDeleteBlockedSoleOwnerError'
		this.blockers = blockers
	}
}

export type SoftDeleteOrgResult = {
	orgId: OwnerId
	deletedAt: string
	resourceRowsSoftDeleted: number
	jobsSoftDeleted: number
	/** True when this call finished a generation that was already stamped. */
	resumed: boolean
}

async function claimSoftDeleteGeneration(input: {
	db: D1Database
	selectSql: string
	id: string
	nowIso: string
	missingError: string
	stamp: (deletedAt: string) => Promise<number>
}): Promise<{ deletedAt: string; resumed: boolean }> {
	const existing = await input.db
		.prepare(input.selectSql)
		.bind(input.id)
		.first<{ deleted_at: string | null }>()
	if (!existing) throw new Error(input.missingError)
	if (existing.deleted_at) {
		return { deletedAt: existing.deleted_at, resumed: true }
	}
	const changes = await input.stamp(input.nowIso)
	if (changes > 0) return { deletedAt: input.nowIso, resumed: false }
	const again = await input.db
		.prepare(input.selectSql)
		.bind(input.id)
		.first<{ deleted_at: string | null }>()
	if (!again?.deleted_at) throw new Error(input.missingError)
	return { deletedAt: again.deleted_at, resumed: true }
}

async function softDeleteOrgOwnedAppRows(input: {
	appDb: D1Database
	orgId: OwnerId
	deletedAt: string
}): Promise<number> {
	let total = 0
	for (const table of orgOwnedUserIdSoftDeleteTables) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = ?
				 WHERE user_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.deletedAt, input.orgId)
			.run()
		total += result.meta.changes ?? 0
	}
	for (const table of [
		'org_memberships',
		'teams',
		'grants',
		'org_user_budgets',
	] as const) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = ?
				 WHERE org_id = ? AND deleted_at IS NULL`,
			)
			.bind(input.deletedAt, input.orgId)
			.run()
		total += result.meta.changes ?? 0
	}
	const teamMembers = await input.appDb
		.prepare(
			`UPDATE team_members
			 SET deleted_at = ?
			 WHERE deleted_at IS NULL
			   AND team_id IN (SELECT id FROM teams WHERE org_id = ?)`,
		)
		.bind(input.deletedAt, input.orgId)
		.run()
	total += teamMembers.meta.changes ?? 0
	const listings = await input.appDb
		.prepare(
			`UPDATE community_listings
			 SET deleted_at = ?
			 WHERE owner_user_id = ? AND deleted_at IS NULL`,
		)
		.bind(input.deletedAt, input.orgId)
		.run()
	total += listings.meta.changes ?? 0
	for (const {
		child,
		parent,
		parentKey,
	} of orgOwnedBucketChildSoftDeleteTables) {
		const children = await input.appDb
			.prepare(
				`UPDATE ${child}
				 SET deleted_at = ?
				 WHERE deleted_at IS NULL
				   AND ${parentKey} IN (
				     SELECT id FROM ${parent}
				     WHERE user_id = ? AND deleted_at = ?
				   )`,
			)
			.bind(input.deletedAt, input.orgId, input.deletedAt)
			.run()
		total += children.meta.changes ?? 0
	}
	return total
}

async function restoreOrgOwnedAppRows(input: {
	appDb: D1Database
	orgId: OwnerId
	deletedAt: string
}): Promise<number> {
	let total = 0
	for (const table of orgOwnedUserIdRestoreTables) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = NULL, deleting_at = NULL
				 WHERE user_id = ? AND deleted_at = ?`,
			)
			.bind(input.orgId, input.deletedAt)
			.run()
		total += result.meta.changes ?? 0
	}
	for (const table of ['teams', 'grants', 'org_user_budgets'] as const) {
		const result = await input.appDb
			.prepare(
				`UPDATE ${table}
				 SET deleted_at = NULL
				 WHERE org_id = ? AND deleted_at = ?`,
			)
			.bind(input.orgId, input.deletedAt)
			.run()
		total += result.meta.changes ?? 0
	}
	const teamMembers = await input.appDb
		.prepare(
			`UPDATE team_members
			 SET deleted_at = NULL
			 WHERE deleted_at = ?
			   AND team_id IN (SELECT id FROM teams WHERE org_id = ?)
			   AND user_id IN (
			     SELECT stable_user_id FROM users WHERE deleted_at IS NULL
			   )`,
		)
		.bind(input.deletedAt, input.orgId)
		.run()
	total += teamMembers.meta.changes ?? 0
	const listings = await input.appDb
		.prepare(
			`UPDATE community_listings
			 SET deleted_at = NULL, deleting_at = NULL
			 WHERE owner_user_id = ? AND deleted_at = ?`,
		)
		.bind(input.orgId, input.deletedAt)
		.run()
	total += listings.meta.changes ?? 0
	for (const {
		child,
		parent,
		parentKey,
	} of orgOwnedBucketChildSoftDeleteTables) {
		const children = await input.appDb
			.prepare(
				`UPDATE ${child}
				 SET deleted_at = NULL, deleting_at = NULL
				 WHERE deleted_at = ?
				   AND ${parentKey} IN (
				     SELECT id FROM ${parent}
				     WHERE user_id = ? AND deleted_at IS NULL
				   )`,
			)
			.bind(input.deletedAt, input.orgId)
			.run()
		total += children.meta.changes ?? 0
	}
	return total
}

export async function softDeleteOrg(input: {
	env: Env
	orgId: OwnerId
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}): Promise<SoftDeleteOrgResult> {
	const appDb = input.env.APP_DB
	const nowIso = (input.now ?? new Date()).toISOString()
	const already = await appDb
		.prepare(`SELECT deleted_at FROM orgs WHERE id = ?`)
		.bind(input.orgId)
		.first<{ deleted_at: string | null }>()
	if (!already) throw new Error('org_not_found_or_already_deleted')

	// Refuse a new soft-delete while a live person still owns this as their
	// personal org. Account deletion stamps the person first, so
	// isPersonalOrg is false when softDeleteUserAccount calls us. Resume of an
	// already-tombstoned org skips this check.
	if (!already.deleted_at && (await isPersonalOrg(appDb, input.orgId))) {
		throw new PersonalOrgDeleteRequiresAccountDeletionError()
	}

	// Fence live orgs before the tombstone so a concurrent packageSave cannot
	// insert after its table was swept. A generation that is already stamped
	// is resumed without a new fence: deleted_at already blocks OwnerId writes.
	if (!already.deleted_at) {
		const marked = await markOrgDeleting({
			db: appDb,
			orgId: input.orgId,
			now: new Date(nowIso),
			env: input.env,
		})
		if (marked.leaseCount > 0) {
			try {
				if (marked.created) {
					await abortOrgDeleting({
						db: appDb,
						orgId: input.orgId,
						now: new Date(nowIso),
						env: input.env,
						expectedDeletingAt: marked.deletingAt,
					})
				}
			} finally {
				// Prefer the lease-busy signal even when abort's UserMeter RPC fails;
				// leftover heal clears meter tombstones once D1 is live again.
				throw new AccountDeletionWritersActiveError(marked.leaseCount)
			}
		}
	}

	const { deletedAt, resumed } = await claimSoftDeleteGeneration({
		db: appDb,
		selectSql: `SELECT deleted_at FROM orgs WHERE id = ?`,
		id: input.orgId,
		nowIso,
		missingError: 'org_not_found_or_already_deleted',
		stamp: async (stampAt) => {
			const orgUpdate = await appDb
				.prepare(
					`UPDATE orgs
					 SET deleted_at = ?, updated_at = ?
					 WHERE id = ? AND deleted_at IS NULL`,
				)
				.bind(stampAt, stampAt, input.orgId)
				.run()
			return orgUpdate.meta.changes ?? 0
		},
	})

	// Spec §10.1 / §10.3: revoke credentials bound to the org. Team-bound tokens
	// store the person on user_id and the org on org_id (same COALESCE match as
	// member offboarding). Soft-delete also tombstones api_tokens; restore never
	// clears those tombstones. After deleted_at is set, leave write fences in
	// place even if a later step fails — fail closed for OwnerId writes.
	await appDb
		.prepare(
			`UPDATE api_tokens
			 SET revoked_at = ?, updated_at = ?, deleted_at = ?
			 WHERE COALESCE(org_id, user_id) = ?
			   AND deleted_at IS NULL`,
		)
		.bind(deletedAt, deletedAt, deletedAt, input.orgId)
		.run()
	await appDb
		.prepare(
			`DELETE FROM cli_credential_bootstrap_codes
			 WHERE COALESCE(org_id, user_id) = ?`,
		)
		.bind(input.orgId)
		.run()

	const oauthHelpers = (await resolveOAuthHelpers(input.env)) as
		| OAuthGrantHelpers
		| undefined
	if (oauthHelpers) {
		const members = await appDb
			.prepare(
				`SELECT user_id FROM org_memberships
				 WHERE org_id = ? AND (deleted_at IS NULL OR deleted_at = ?)`,
			)
			.bind(input.orgId, deletedAt)
			.all<{ user_id: string }>()
		for (const member of members.results ?? []) {
			await revokeOAuthGrantsForOrg({
				helpers: oauthHelpers,
				memberUserId: member.user_id,
				orgId: input.orgId,
			})
		}
		// Personal org: owner id equals org id; also revoke grants listed under
		// that user id when memberships were never expanded.
		if (!(members.results ?? []).some((row) => row.user_id === input.orgId)) {
			await revokeOAuthGrantsForOrg({
				helpers: oauthHelpers,
				memberUserId: input.orgId,
				orgId: input.orgId,
			})
		}
	}

	const resourceRowsSoftDeleted = await softDeleteOrgOwnedAppRows({
		appDb,
		orgId: input.orgId,
		deletedAt,
	})
	const jobsSoftDeleted = await jobsData(input.env).softDeleteJobsForUser({
		userId: input.orgId,
		deletedAt,
	})
	await syncJobManagerAlarm({ env: input.env, userId: input.orgId })
	invalidatePackageAppOwnerCache({ stableUserId: input.orgId })
	const billing = await cancelKodySubscriptionsForSoftDelete({
		env: input.env,
		ownerId: input.orgId,
	})

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.orgId,
		action: 'org.deleted',
		result: 'success',
		actorUserId: input.actorUserId,
		actorUsername: input.actorUsername,
		detailsJson: JSON.stringify({
			deletedAt,
			resumed,
			resourceRowsSoftDeleted,
			jobsSoftDeleted,
			stripeSubscriptionsCanceled: billing.canceled,
		}),
		createdAt: deletedAt,
	})

	return {
		orgId: input.orgId,
		deletedAt,
		resourceRowsSoftDeleted,
		jobsSoftDeleted,
		resumed,
	}
}

/**
 * Owner memberships that authorize restore for a soft-deleted org: either
 * tombstoned at the same generation as the org, or still live when soft-delete
 * stamped the org and then failed before membership tombstones.
 */
const restoreOwnerMembershipJoinSql = `
			  AND m.role = 'owner'
			  AND (
			    m.deleted_at = o.deleted_at
			    OR m.deleted_at IS NULL
			  )`

/**
 * Soft-deleted orgs cannot be bound as the request org (memberships are
 * tombstoned). Restore authorization checks that the actor was an Owner of
 * the org at the deletion generation instead.
 */
export async function assertActorCanRestoreSoftDeletedOrg(input: {
	db: D1Database
	orgId: OwnerId
	actorUserId: string
}): Promise<{ deletedAt: string }> {
	const row = await input.db
		.prepare(
			`SELECT o.deleted_at AS deleted_at
			 FROM orgs o
			 INNER JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  ${restoreOwnerMembershipJoinSql}
			 WHERE o.id = ?
			   AND o.deleted_at IS NOT NULL`,
		)
		.bind(input.actorUserId, input.orgId)
		.first<{ deleted_at: string }>()
	if (!row?.deleted_at) {
		throw new Error('org_restore_forbidden')
	}
	return { deletedAt: row.deleted_at }
}

export type RestorableOrganization = {
	orgId: OwnerId
	slug: string
	displayName: string | null
	deletedAt: string
	avatarKey: string | null
}

/**
 * Soft-deleted team organizations the actor owned at the deletion generation
 * and that are still inside the restore window. Personal orgs are omitted —
 * those restore only with the person account.
 */
export async function listRestorableOrganizationsForPerson(input: {
	db: D1Database
	actorUserId: string
	now?: Date
}): Promise<Array<RestorableOrganization>> {
	const now = input.now ?? new Date()
	const cutoff = softDeletePurgeCutoffIso(now)
	const rows = await input.db
		.prepare(
			`SELECT o.id AS org_id,
			        o.slug AS slug,
			        o.display_name AS display_name,
			        o.deleted_at AS deleted_at,
			        o.avatar_key AS avatar_key
			 FROM orgs o
			 INNER JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  ${restoreOwnerMembershipJoinSql}
			 WHERE o.deleted_at IS NOT NULL
			   AND o.deleted_at >= ?
			   AND NOT EXISTS (
			     SELECT 1 FROM users u
			     WHERE u.stable_user_id = o.id
			        OR u.personal_org_id = o.id
			   )
			 ORDER BY o.deleted_at DESC, o.slug ASC`,
		)
		.bind(input.actorUserId, cutoff)
		.all<{
			org_id: string
			slug: string
			display_name: string | null
			deleted_at: string
			avatar_key: string | null
		}>()
	return (rows.results ?? []).map((row) => ({
		orgId: ownerIdFromStored(row.org_id),
		slug: row.slug,
		displayName: row.display_name,
		deletedAt: row.deleted_at,
		avatarKey: row.avatar_key,
	}))
}

/**
 * Soft-deleted organization named by slug when the actor can restore it
 * within the window. Used by create-org ("offer restore") and the restore
 * POST (slug in the URL; no raw id in the UI).
 */
export async function loadRestorableOrganizationBySlugForPerson(input: {
	db: D1Database
	actorUserId: string
	slug: string
	now?: Date
}): Promise<RestorableOrganization | null> {
	const now = input.now ?? new Date()
	const cutoff = softDeletePurgeCutoffIso(now)
	const row = await input.db
		.prepare(
			`SELECT o.id AS org_id,
			        o.slug AS slug,
			        o.display_name AS display_name,
			        o.deleted_at AS deleted_at,
			        o.avatar_key AS avatar_key
			 FROM orgs o
			 INNER JOIN org_memberships m
			   ON m.org_id = o.id
			  AND m.user_id = ?
			  ${restoreOwnerMembershipJoinSql}
			 WHERE o.slug = ?
			   AND o.deleted_at IS NOT NULL
			   AND o.deleted_at >= ?
			   AND NOT EXISTS (
			     SELECT 1 FROM users u
			     WHERE u.stable_user_id = o.id
			        OR u.personal_org_id = o.id
			   )
			 LIMIT 1`,
		)
		.bind(input.actorUserId, input.slug, cutoff)
		.first<{
			org_id: string
			slug: string
			display_name: string | null
			deleted_at: string
			avatar_key: string | null
		}>()
	if (!row) return null
	return {
		orgId: ownerIdFromStored(row.org_id),
		slug: row.slug,
		displayName: row.display_name,
		deletedAt: row.deleted_at,
		avatarKey: row.avatar_key,
	}
}

/**
 * A restored free org counts toward its Owners' two-free-org cap again, the
 * same as creating one. Refuse when a live Owner whose membership this restore
 * would revive (same deletion generation; deleted people are not revived) is
 * already at the cap. This produces the message; the restore UPDATE re-checks
 * the same condition atomically (`freeOrgCapRestoreGuardSql`).
 */
async function assertRestoreKeepsOwnersUnderFreeOrgCap(input: {
	db: D1Database
	orgId: string
	deletedAt: string
}) {
	const owners = await input.db
		.prepare(
			`SELECT m.user_id AS user_id, h.handle AS handle
			 FROM org_memberships m
			 INNER JOIN users u ON u.stable_user_id = m.user_id AND u.deleted_at IS NULL
			 LEFT JOIN handles h ON h.user_id = m.user_id
			 WHERE m.org_id = ?
			   AND m.role = 'owner'
			   AND (m.deleted_at = ? OR m.deleted_at IS NULL)`,
		)
		.bind(input.orgId, input.deletedAt)
		.all<{ user_id: string; handle: string | null }>()
	for (const owner of owners.results ?? []) {
		const count = await countLiveFreeOwnedOrgs(input.db, owner.user_id)
		if (count >= MAX_FREE_ORGS_PER_USER) {
			const who = owner.handle ? `@${owner.handle}` : 'an Owner'
			throw new FreeOrgLimitError(
				`Restoring this organization would give ${who} more than ${String(MAX_FREE_ORGS_PER_USER)} free organizations. Make one paid or delete one before restoring.`,
			)
		}
	}
}

/**
 * Guard for the restore UPDATE: no live Owner this restore would revive may
 * already own `MAX_FREE_ORGS_PER_USER` live free orgs. Evaluated inside the
 * same statement that clears the tombstone, so two concurrent restores for one
 * Owner cannot both pass the cap check and then both go live.
 */
const freeOrgCapRestoreGuardSql = `
	AND NOT EXISTS (
		SELECT 1
		FROM org_memberships m
		INNER JOIN users u ON u.stable_user_id = m.user_id AND u.deleted_at IS NULL
		WHERE m.org_id = orgs.id
		  AND m.role = 'owner'
		  AND (m.deleted_at = orgs.deleted_at OR m.deleted_at IS NULL)
		  AND (
		    SELECT COUNT(*)
		    FROM orgs o2
		    INNER JOIN org_memberships m2
		      ON m2.org_id = o2.id
		     AND m2.user_id = m.user_id
		     AND m2.role = 'owner'
		     AND m2.deleted_at IS NULL
		    WHERE ${effectiveFreeOrgSql('o2')} AND o2.deleted_at IS NULL
		  ) >= ?
	)`

export async function restoreOrg(input: {
	env: Env
	orgId: OwnerId
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}) {
	const now = input.now ?? new Date()
	const appDb = input.env.APP_DB
	const row = await appDb
		.prepare(
			`SELECT deleted_at, plan, stripe_plan, stripe_customer_id, slug
			 FROM orgs WHERE id = ?`,
		)
		.bind(input.orgId)
		.first<{
			deleted_at: string | null
			plan: string
			stripe_plan: string | null
			stripe_customer_id: string | null
			slug: string
		}>()
	if (!row?.deleted_at) {
		throw new Error('org_not_deleted')
	}
	if (isReleasedOrgSlug(row.slug)) {
		throw new Error('org_superseded_by_new_signup')
	}
	if (!isWithinSoftDeleteRestoreWindow(row.deleted_at, now)) {
		throw new OrgRestoreWindowExpiredError()
	}
	// Soft-delete cancels Kody subscriptions, so a tombstone's Stripe plan is stale.
	const freeOrg = !isPaidOrg(row.plan)
	const deletedAt = row.deleted_at
	const assertUnderCap = () =>
		assertRestoreKeepsOwnersUnderFreeOrgCap({
			db: appDb,
			orgId: input.orgId,
			deletedAt,
		})
	if (freeOrg) await assertUnderCap()
	const restoredAt = now.toISOString()

	// The org row and its Owner memberships go live in one atomic batch so the
	// cap guard of a concurrent restore never sees a live org whose Owner
	// membership is still tombstoned. Only people who are still live accounts
	// are revived: a member who soft-deleted their own account must not regain
	// access on org restore. The same statement bumps access_epoch: cached auth
	// decisions from before the soft-delete must not match the revived org.
	const [orgUpdate, memberships] = await appDb.batch([
		appDb
			.prepare(
				`UPDATE orgs
				 SET deleted_at = NULL, deleting_at = NULL, updated_at = ?,
				     access_epoch = access_epoch + 1
				 WHERE id = ? AND deleted_at = ?
				   AND slug NOT LIKE '~released-%'${freeOrg ? freeOrgCapRestoreGuardSql : ''}`,
			)
			.bind(
				restoredAt,
				input.orgId,
				deletedAt,
				...(freeOrg ? [MAX_FREE_ORGS_PER_USER] : []),
			),
		appDb
			.prepare(
				`UPDATE org_memberships
				 SET deleted_at = NULL
				 WHERE org_id = ?
				   AND deleted_at = ?
				   AND EXISTS (SELECT 1 FROM orgs WHERE id = ? AND deleted_at IS NULL)
				   AND user_id IN (
				     SELECT stable_user_id FROM users WHERE deleted_at IS NULL
				   )`,
			)
			.bind(input.orgId, deletedAt, input.orgId),
	])
	if ((orgUpdate?.meta.changes ?? 0) === 0) {
		// Either another restore won, or a concurrent restore for one of the
		// Owners went live first and the guard refused this one.
		if (freeOrg) await assertUnderCap()
		throw new Error('org_restore_race')
	}

	// Soft-delete fences the org-id UserMeter; clear it after D1 is live again
	// so the first post-restore write does not depend on leftover-tombstone heal.
	await clearUserMeterDeletionTombstone({
		env: input.env,
		stableUserId: input.orgId,
	})

	const resourceRowsRestored =
		(memberships?.meta.changes ?? 0) +
		(await restoreOrgOwnedAppRows({
			appDb,
			orgId: input.orgId,
			deletedAt,
		}))
	// teams, team_members and grants came back after the org went live, so a
	// binding compiled in between saw a partial graph: bump again so it misses.
	await bumpAccessEpochStatement(appDb, input.orgId).run()
	const jobsRestored = await jobsData(input.env).restoreJobsForUser({
		userId: input.orgId,
		deletedAt,
		restoredAt,
	})
	await syncJobManagerAlarm({ env: input.env, userId: input.orgId })

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.orgId,
		action: 'org.restored',
		result: 'success',
		actorUserId: input.actorUserId,
		actorUsername: input.actorUsername,
		detailsJson: JSON.stringify({
			restoredDeletedAt: deletedAt,
			resourceRowsRestored,
			jobsRestored,
		}),
		createdAt: restoredAt,
	})

	if (row.stripe_customer_id) {
		try {
			await refreshStripePlanForOrg({
				env: input.env,
				orgId: input.orgId,
				customerId: row.stripe_customer_id,
				now,
			})
		} catch (error) {
			console.warn('org-restore-stripe-refresh-failed', {
				orgId: input.orgId,
				error,
			})
		}
	}

	return {
		orgId: input.orgId,
		restoredAt,
		resourceRowsRestored,
		jobsRestored,
	}
}

export async function assertUserDeleteNotBlockedAsSoleOwner(input: {
	db: D1Database
	userId: OwnerId
}) {
	const memberships = await input.db
		.prepare(
			`SELECT m.org_id AS org_id, m.role AS role, o.slug AS slug
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.deleted_at IS NULL
			   AND o.deleted_at IS NULL`,
		)
		.bind(input.userId)
		.all<{ org_id: OwnerId; role: string; slug: string }>()

	const blockers: Array<{ orgId: OwnerId; orgSlug: string }> = []
	for (const membership of memberships.results ?? []) {
		if (membership.role !== 'owner') continue
		const others = await input.db
			.prepare(
				`SELECT COUNT(*) AS count FROM org_memberships
				 WHERE org_id = ? AND user_id != ?${andLiveDeletedAtSql()}`,
			)
			.bind(membership.org_id, input.userId)
			.first<{ count: number }>()
		const otherMemberCount = Number(others?.count ?? 0)
		if (otherMemberCount === 0) continue
		const otherOwners = await input.db
			.prepare(
				`SELECT COUNT(*) AS count FROM org_memberships
				 WHERE org_id = ? AND role = 'owner' AND user_id != ?${andLiveDeletedAtSql()}`,
			)
			.bind(membership.org_id, input.userId)
			.first<{ count: number }>()
		if (Number(otherOwners?.count ?? 0) === 0) {
			blockers.push({
				orgId: membership.org_id,
				orgSlug: membership.slug,
			})
		}
	}
	if (blockers.length > 0) {
		throw new UserDeleteBlockedSoleOwnerError(blockers)
	}
}

/**
 * Soft-delete a user and their sole-member orgs. Other-org memberships go
 * through {@link onMemberSoftRemoved}.
 *
 * The person row is tombstoned first (OwnerId writes stay blocked via
 * {@link assertAccountWritableDb} even if a personal org is still live).
 * {@link softDeleteOrg} fences each org itself; if it refuses for an active
 * lease, retry this function — it resumes from an existing person tombstone
 * and continues remaining sole-member orgs, memberships, and billing cancel.
 * {@link restoreUserAccount} only revives orgs that share the person's
 * `deleted_at`.
 */
export async function softDeleteUserAccount(input: {
	env: Env
	userId: OwnerId
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}) {
	await assertUserDeleteNotBlockedAsSoleOwner({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	const appDb = input.env.APP_DB
	// `userId` is the person (`stable_user_id`). Org-keyed audit/billing use
	// `users.personal_org_id` when it differs (#3053 phase 2).
	const personRow = await appDb
		.prepare(
			`SELECT stable_user_id, personal_org_id FROM users WHERE stable_user_id = ?`,
		)
		.bind(input.userId)
		.first<{ stable_user_id: string; personal_org_id: string | null }>()
	const personalOrgId = personRow
		? personalOrgIdFromUserRow(personRow)
		: ownerIdFromStored(input.userId as string)
	const { deletedAt, resumed } = await claimSoftDeleteGeneration({
		db: appDb,
		selectSql: `SELECT deleted_at FROM users WHERE stable_user_id = ?`,
		id: input.userId,
		nowIso: (input.now ?? new Date()).toISOString(),
		missingError: 'user_not_found_or_already_deleted',
		stamp: async (stampAt) => {
			const userUpdate = await appDb
				.prepare(
					`UPDATE users
					 SET deleted_at = ?, updated_at = ?
					 WHERE stable_user_id = ? AND deleted_at IS NULL`,
				)
				.bind(stampAt, stampAt, input.userId)
				.run()
			return userUpdate.meta.changes ?? 0
		},
	})
	const fenceAt = new Date(deletedAt)

	// A shared org is sole-owned only while this membership is still live and
	// no other member is. A membership already tombstoned in this generation
	// stays on the offboard path unless the org itself was tombstoned then.
	// Otherwise a later departure of the remaining members would make a retry
	// delete their org.
	const soleMemberOrgs = await appDb
		.prepare(
			`SELECT m.org_id AS org_id
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND (
			     (
			       m.deleted_at IS NULL
			       AND o.deleted_at IS NULL
			       AND NOT EXISTS (
			         SELECT 1 FROM org_memberships other
			         WHERE other.org_id = m.org_id
			           AND other.user_id != ?
			           AND other.deleted_at IS NULL
			       )
			     )
			     OR (
			       o.deleted_at = ?
			       AND (m.deleted_at IS NULL OR m.deleted_at = ?)
			     )
			   )`,
		)
		.bind(input.userId, input.userId, deletedAt, deletedAt)
		.all<{ org_id: OwnerId }>()

	const deletedOrgIds: Array<string> = []
	const soleOrgIds = new Set<string>()
	for (const row of soleMemberOrgs.results ?? []) {
		soleOrgIds.add(row.org_id)
		await softDeleteOrg({
			env: input.env,
			orgId: row.org_id,
			actorUserId: input.actorUserId ?? input.userId,
			actorUsername: input.actorUsername,
			now: fenceAt,
		})
		deletedOrgIds.push(row.org_id)
	}

	const otherMemberships = await appDb
		.prepare(
			`SELECT org_id FROM org_memberships
			 WHERE user_id = ? AND (deleted_at IS NULL OR deleted_at = ?)`,
		)
		.bind(input.userId, deletedAt)
		.all<{ org_id: OwnerId }>()
	for (const row of otherMemberships.results ?? []) {
		if (soleOrgIds.has(row.org_id)) continue
		await onMemberSoftRemoved({
			env: input.env,
			orgId: row.org_id,
			userId: input.userId,
			deletedAt,
			resume: true,
			audit: orgAuditWriterForPerson(input.env, {
				userId: input.actorUserId ?? input.userId,
				username: input.actorUsername,
			}),
		})
	}

	// Log on every successful completion, including resume after a lease
	// refuse — otherwise a first attempt that tombstones the person then
	// throws never writes user.deleted, and the retry skips it too.
	await logOrgAuditEvent({
		env: input.env,
		orgId: personalOrgId,
		action: 'user.deleted',
		result: 'success',
		actorUserId: input.actorUserId ?? input.userId,
		actorUsername: input.actorUsername,
		targetUserId: input.userId,
		detailsJson: JSON.stringify({ deletedAt, deletedOrgIds, resumed }),
		createdAt: (input.now ?? new Date()).toISOString(),
	})

	invalidatePackageAppOwnerCache({ stableUserId: input.userId })
	// Sole personal org cancel runs inside softDeleteOrg above; this covers
	// equal-id / resume paths where billing still keys the signup org.
	await cancelKodySubscriptionsForSoftDelete({
		env: input.env,
		ownerId: personalOrgId,
	})

	return { userId: input.userId, deletedAt, deletedOrgIds, resumed }
}

/**
 * Restore a soft-deleted user and sole-member orgs tombstoned at the same
 * `deleted_at` within the restore window.
 */
export async function restoreUserAccount(input: {
	env: Env
	userId: OwnerId
	actorUserId?: string | null
	actorUsername?: string | null
	now?: Date
}) {
	const now = input.now ?? new Date()
	const restoredAt = now.toISOString()
	const userRow = await input.env.APP_DB.prepare(
		`SELECT deleted_at, email FROM users WHERE stable_user_id = ?`,
	)
		.bind(input.userId)
		.first<{ deleted_at: string | null; email: string }>()
	if (!userRow?.deleted_at) {
		throw new Error('user_not_deleted')
	}
	// A fresh signup with this email superseded the account and took its
	// email and handle; restoring it would revive a nameless account.
	if (isReleasedAccountEmail(userRow.email)) {
		throw new Error('user_superseded_by_new_signup')
	}
	if (!isWithinSoftDeleteRestoreWindow(userRow.deleted_at, now)) {
		throw new OrgRestoreWindowExpiredError()
	}
	const deletedAt = userRow.deleted_at

	const userUpdate = await input.env.APP_DB.prepare(
		`UPDATE users
		 SET deleted_at = NULL, deleting_at = NULL, updated_at = ?
		 WHERE stable_user_id = ? AND deleted_at = ?
		   AND email NOT LIKE '%@released.kody.invalid'`,
	)
		.bind(restoredAt, input.userId, deletedAt)
		.run()
	if ((userUpdate.meta.changes ?? 0) === 0) {
		throw new Error('user_restore_race')
	}

	const deletedOrgs = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs WHERE deleted_at = ?`,
	)
		.bind(deletedAt)
		.all<{ id: OwnerId }>()
	const restoredOrgIds: Array<string> = []
	for (const row of deletedOrgs.results ?? []) {
		const membership = await input.env.APP_DB.prepare(
			`SELECT 1 AS ok FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND deleted_at = ?`,
		)
			.bind(row.id, input.userId, deletedAt)
			.first<{ ok: number }>()
		if (!membership) continue
		await restoreOrg({
			env: input.env,
			orgId: row.id,
			actorUserId: input.actorUserId ?? input.userId,
			actorUsername: input.actorUsername,
			now,
		})
		restoredOrgIds.push(row.id)
	}

	await logOrgAuditEvent({
		env: input.env,
		orgId: input.userId,
		action: 'user.restored',
		result: 'success',
		actorUserId: input.actorUserId ?? input.userId,
		actorUsername: input.actorUsername,
		targetUserId: input.userId,
		detailsJson: JSON.stringify({
			restoredDeletedAt: deletedAt,
			restoredOrgIds,
		}),
		createdAt: restoredAt,
	})

	return { userId: input.userId, restoredAt, restoredOrgIds }
}

const resourceRestoreTableByType: Record<string, string> = {
	package: 'saved_packages',
	secret: 'secret_buckets',
	integration: 'user_integrations',
	memory: 'mcp_memories',
	email: 'email_inboxes',
}

/** Minimal P7 restore for one org-owned resource row (stub for MCP). */
export async function restoreResourceRow(input: {
	env: Env
	orgId: OwnerId
	resourceType: string
	resourceId: string
	now?: Date
}): Promise<{ restored: boolean }> {
	const table =
		resourceRestoreTableByType[input.resourceType.trim().toLowerCase()]
	if (!table) return { restored: false }
	const org = await input.env.APP_DB.prepare(
		`SELECT deleted_at FROM orgs WHERE id = ? AND deleted_at IS NOT NULL`,
	)
		.bind(input.orgId)
		.first<{ deleted_at: string }>()
	if (!org?.deleted_at) return { restored: false }
	if (!isWithinSoftDeleteRestoreWindow(org.deleted_at, input.now)) {
		throw new OrgRestoreWindowExpiredError()
	}
	const result = await input.env.APP_DB.prepare(
		`UPDATE ${table}
		 SET deleted_at = NULL
		 WHERE user_id = ? AND id = ? AND deleted_at = ?`,
	)
		.bind(input.orgId, input.resourceId, org.deleted_at)
		.run()
	return { restored: (result.meta.changes ?? 0) > 0 }
}
