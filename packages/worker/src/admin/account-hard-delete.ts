/**
 * soft-delete-read-filter: opt-out
 *
 * Resume after a partial hard-delete must read the tombstoned person and the
 * organizations already soft-deleted with them. Live product lookups stay
 * filtered; this module also reads `deleted_at IS NOT NULL`.
 *
 * Admin hard-delete of one person account.
 *
 * Self-serve deletion soft-deletes and keeps the username, handle, and org
 * slug reserved for the 30-day restore window. This path soft-deletes first
 * (so shared organizations are left intact and sole-member organizations go
 * through the existing tombstone), then hard-purges immediately so the handle
 * can be registered again.
 *
 * Organizations the person does not solely own are not purged. Membership in
 * those organizations is removed by the soft-delete offboarding path.
 */
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { jobsData, jobsService } from '#worker/jobs/jobs-data.ts'
import { readCreditWallet } from '#worker/billing/credit-wallet.ts'
import { scheduleUserDeletedEvent } from '#worker/identity/schedule-user-lifecycle-event.ts'
import {
	auditDatabaseFromEnv,
	logAuditEvent,
	redactEmailRecipient,
} from '#worker/audit-log.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
} from '#app/account-deletion.ts'
import {
	hardPurgeOrg,
	hardPurgeSoftDeletedUser,
} from '#worker/orgs/hard-purge.ts'
import {
	UserDeleteBlockedSoleOwnerError,
	softDeleteOrg,
	softDeleteUserAccount,
} from '#worker/orgs/soft-delete.ts'
import {
	loadAdminUserByTarget,
	type AdminUserTarget,
} from '#worker/admin/users-data.ts'
import {
	assignUserRole,
	removeAdminRolePreservingLastAdmin,
} from '#worker/identity/permissions-db.ts'
import {
	adminAccountDeletionApprovalTtlMs,
	adminAccountDeletionHandleMatches,
	type AdminAccountDeletionAcknowledgementReason,
	type AdminAccountDeletionApprovalState,
	type AdminAccountDeletionSummary,
} from '#universal/admin-account-deletion.ts'
import { adminOperationResult } from './operation-result.ts'

export class AdminAccountHardDeleteError extends Error {
	readonly status: number
	readonly code:
		| 'not_found'
		| 'last_admin'
		| 'acknowledgement_required'
		| 'handle_mismatch'
		| 'approval_invalid'
		| 'cleanup_failed'

	constructor(
		message: string,
		status: number,
		code: AdminAccountHardDeleteError['code'],
	) {
		super(message)
		this.name = 'AdminAccountHardDeleteError'
		this.status = status
		this.code = code
	}
}

type Actor = {
	stableUserId: string
	email: string
	username: string
}

type SoleOrg = {
	orgId: OwnerId
	slug: string
	otherMemberCount: number
}

type DeletionTarget = {
	dbUserId: number
	stableUserId: OwnerId
	personalOrgId: OwnerId
	handle: string
	email: string
	createdAt: string
	plan: string
	manualPlan: string
	stripePlan: string | null
	isAdmin: boolean
	soleOwnedNonPersonalOrgs: Array<SoleOrg>
}

const lastAdminMessage =
	'This is the last admin account. Promote another admin before deleting it.'

function paidPlan(manualPlan: string, stripePlan: string | null) {
	if (stripePlan && stripePlan !== 'free') return stripePlan
	return manualPlan || 'free'
}

function isPaidBilling(manualPlan: string, stripePlan: string | null) {
	return (
		(manualPlan !== '' && manualPlan !== 'free') ||
		(stripePlan != null && stripePlan !== '' && stripePlan !== 'free')
	)
}

async function countQuery(
	db: D1Database,
	sql: string,
	params: Array<string | number>,
) {
	const row = await db
		.prepare(sql)
		.bind(...params)
		.first<{ count: number }>()
	return Number(row?.count ?? 0)
}

async function countJobsForOwner(env: Env, ownerId: string) {
	const service = jobsService(env)
	if (service?.countJobsForUser) {
		return service.countJobsForUser({ userId: ownerId })
	}
	if (service?.listJobIdsForUser) {
		return (await service.listJobIdsForUser({ userId: ownerId })).length
	}
	return jobsData(env).countJobsForUser({ userId: ownerId })
}

async function countAcrossOwners(
	ownerIds: Array<string>,
	countOne: (ownerId: string) => Promise<number>,
) {
	let total = 0
	for (const ownerId of ownerIds) total += await countOne(ownerId)
	return total
}

async function loadSoleOwnedNonPersonalOrgs(
	db: D1Database,
	userId: OwnerId,
	personalOrgId: OwnerId,
) {
	const memberships = await db
		.prepare(
			`SELECT m.org_id AS org_id, o.slug AS slug
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			   AND m.role = 'owner'
			   AND m.org_id != ?
			   ${andLiveDeletedAtSql('m')}
			   ${andLiveDeletedAtSql('o')}`,
		)
		.bind(userId, personalOrgId)
		.all<{ org_id: string; slug: string }>()
	const sole: Array<SoleOrg> = []
	for (const membership of memberships.results ?? []) {
		const counts = await db
			.prepare(
				`SELECT
				   (SELECT COUNT(*) FROM org_memberships
				    WHERE org_id = ? AND user_id != ?${andLiveDeletedAtSql()}) AS members,
				   (SELECT COUNT(*) FROM org_memberships
				    WHERE org_id = ? AND role = 'owner' AND user_id != ?${andLiveDeletedAtSql()}) AS owners`,
			)
			.bind(membership.org_id, userId, membership.org_id, userId)
			.first<{ members: number; owners: number }>()
		if (Number(counts?.owners ?? 0) > 0) continue
		sole.push({
			orgId: ownerIdFromStored(membership.org_id),
			slug: membership.slug,
			otherMemberCount: Number(counts?.members ?? 0),
		})
	}
	return sole
}

async function countLiveAdmins(db: D1Database) {
	return countQuery(
		db,
		`SELECT COUNT(DISTINCT u.id) AS count
		 FROM users u
		 INNER JOIN user_roles ur ON ur.user_id = u.id
		 INNER JOIN roles r ON r.id = ur.role_id
		 WHERE r.name = 'admin'${andLiveDeletedAtSql('u')}`,
		[],
	)
}

async function loadDeletionTarget(
	db: D1Database,
	target: AdminUserTarget,
): Promise<DeletionTarget | null> {
	const listed = await loadAdminUserByTarget(db, target)
	if (!listed) return null
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, personal_org_id
			 FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(listed.stableUserId)
		.first<{
			id: number
			stable_user_id: string
			personal_org_id: string | null
		}>()
	if (!row) return null
	const stableUserId = ownerIdFromStored(row.stable_user_id)
	const personalOrgId = personalOrgIdFromUserRow(row)
	const manualPlan = listed.plan
	const stripePlan = listed.stripePlan
	return {
		dbUserId: row.id,
		stableUserId,
		personalOrgId,
		handle: listed.username,
		email: listed.email,
		createdAt: String(listed.created_at),
		plan: paidPlan(manualPlan, stripePlan),
		manualPlan,
		stripePlan,
		isAdmin: listed.roles.includes('admin'),
		soleOwnedNonPersonalOrgs: await loadSoleOwnedNonPersonalOrgs(
			db,
			stableUserId,
			personalOrgId,
		),
	}
}

async function summarize(
	env: Env,
	target: DeletionTarget,
): Promise<AdminAccountDeletionSummary> {
	const db = env.APP_DB
	const ownerIds = [
		target.personalOrgId,
		...target.soleOwnedNonPersonalOrgs.map((org) => org.orgId),
	]
	const ownerPlaceholders = ownerIds.map(() => '?').join(', ')
	const [
		packages,
		credentials,
		connections,
		agentSessions,
		orgMemberships,
		memories,
		webhooks,
		usage,
		jobs,
		wallet,
		liveAdmins,
	] = await Promise.all([
		countQuery(
			db,
			`SELECT COUNT(*) AS count FROM saved_packages
			 WHERE user_id IN (${ownerPlaceholders})${andLiveDeletedAtSql()}`,
			ownerIds,
		),
		countAcrossOwners(ownerIds, async (ownerId) => {
			const [entries, integrations, providers] = await Promise.all([
				countQuery(
					db,
					`SELECT COUNT(*) AS count
					 FROM secret_entries e
					 INNER JOIN secret_buckets b ON b.id = e.bucket_id
					 WHERE b.user_id = ?${andLiveDeletedAtSql('b')}${andLiveDeletedAtSql('e')}`,
					[ownerId],
				),
				countQuery(
					db,
					`SELECT COUNT(*) AS count FROM user_integrations
					 WHERE user_id = ?${andLiveDeletedAtSql()}`,
					[ownerId],
				),
				countQuery(
					db,
					`SELECT COUNT(*) AS count FROM secret_provider_bindings
					 WHERE user_id = ?${andLiveDeletedAtSql()}`,
					[ownerId],
				),
			])
			return entries + integrations + providers
		}),
		countQuery(
			db,
			`SELECT COUNT(*) AS count FROM oauth_connections WHERE user_id = ?`,
			[target.dbUserId],
		),
		countQuery(
			db,
			`SELECT COUNT(*) AS count FROM mcp_agent_sessions
			 WHERE user_id = ? OR org_id = ?`,
			[target.stableUserId, target.personalOrgId],
		),
		countQuery(
			db,
			`SELECT COUNT(*) AS count FROM org_memberships
			 WHERE user_id = ?${andLiveDeletedAtSql()}`,
			[target.stableUserId],
		),
		countQuery(
			db,
			`SELECT COUNT(*) AS count FROM mcp_memories
			 WHERE user_id IN (${ownerPlaceholders})${andLiveDeletedAtSql()}`,
			ownerIds,
		),
		countQuery(
			db,
			`SELECT COUNT(*) AS count FROM webhook_endpoints
			 WHERE user_id IN (${ownerPlaceholders})${andLiveDeletedAtSql()}`,
			ownerIds,
		),
		countQuery(
			db,
			`SELECT COALESCE(SUM(event_count), 0) AS count FROM usage_rollups
			 WHERE user_id IN (${ownerPlaceholders})`,
			ownerIds,
		),
		countAcrossOwners(ownerIds, (ownerId) => countJobsForOwner(env, ownerId)),
		readCreditWallet(db, target.personalOrgId),
		target.isAdmin ? countLiveAdmins(db) : Promise.resolve(0),
	])
	const reasons: Array<AdminAccountDeletionAcknowledgementReason> = []
	if (packages > 0) reasons.push('packages')
	if (target.soleOwnedNonPersonalOrgs.length > 0) reasons.push('sole_owner')
	if (isPaidBilling(target.manualPlan, target.stripePlan)) {
		reasons.push('paid_billing')
	}
	return {
		handle: target.handle,
		email: target.email,
		createdAt: target.createdAt,
		plan: target.plan,
		counts: {
			packages,
			jobs,
			credentials,
			connections,
			sessions: agentSessions,
			orgMemberships,
			memories,
			webhooks,
			usage,
		},
		creditBalanceMicroUsd: wallet.balanceMicroUsd,
		acknowledgementRequired: reasons.length > 0,
		acknowledgementReasons: reasons,
		soleOwnedNonPersonalOrgs: target.soleOwnedNonPersonalOrgs.map((org) => ({
			slug: org.slug,
			otherMemberCount: org.otherMemberCount,
		})),
		deletionBlocked:
			target.isAdmin && liveAdmins <= 1 ? lastAdminMessage : null,
	}
}

export async function loadAdminAccountDeletionSummary(
	env: Env,
	target: AdminUserTarget,
): Promise<AdminAccountDeletionSummary | null> {
	const loaded = await loadDeletionTarget(env.APP_DB, target)
	if (!loaded) return null
	return summarize(env, loaded)
}

async function loadApprovalSummary(
	env: Env,
	stableUserId: string,
): Promise<AdminAccountDeletionSummary | null> {
	const live = await loadAdminAccountDeletionSummary(env, { stableUserId })
	if (live) return live
	const tombstone = await loadTombstonedDeletionTarget(env.APP_DB, stableUserId)
	if (!tombstone) return null
	return summarize(env, tombstone)
}

async function auditDeletion(input: {
	env: Env
	actor: Actor
	target: DeletionTarget | { stableUserId: string; email: string }
	path: string
	result: 'success' | 'failure'
	reason: string
}) {
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'admin_user_account_delete',
		result: input.result,
		email: input.actor.email,
		path: input.path,
		reason: [
			`target_stable_user_id=${input.target.stableUserId}`,
			`target_email=${redactEmailRecipient(input.target.email)}`,
			`actor_stable_user_id=${input.actor.stableUserId}`,
			input.reason,
		].join(';'),
	})
}

async function loadTombstonedDeletionTarget(
	db: D1Database,
	stableUserId: string,
): Promise<DeletionTarget | null> {
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, username, email, personal_org_id, created_at
			 FROM users
			 WHERE stable_user_id = ? AND deleted_at IS NOT NULL`,
		)
		.bind(stableUserId)
		.first<{
			id: number
			stable_user_id: string
			username: string
			email: string
			personal_org_id: string | null
			created_at: string
		}>()
	if (!row) return null
	const stable = ownerIdFromStored(row.stable_user_id)
	return {
		dbUserId: row.id,
		stableUserId: stable,
		personalOrgId: personalOrgIdFromUserRow(row),
		handle: row.username,
		email: row.email,
		createdAt: row.created_at,
		plan: 'free',
		manualPlan: 'free',
		stripePlan: null,
		isAdmin: false,
		soleOwnedNonPersonalOrgs: [],
	}
}

async function releaseAdminRoleIfNotLast(
	db: D1Database,
	dbUserId: number,
): Promise<'demoted' | 'not_admin' | 'last_admin'> {
	const { removed } = await removeAdminRolePreservingLastAdmin({
		db,
		userId: dbUserId,
	})
	if (removed) return 'demoted'
	const stillAdmin = await db
		.prepare(
			`SELECT 1 AS ok
			 FROM user_roles ur
			 INNER JOIN roles r ON r.id = ur.role_id
			 WHERE ur.user_id = ? AND r.name = 'admin'`,
		)
		.bind(dbUserId)
		.first<{ ok: number }>()
	return stillAdmin ? 'last_admin' : 'not_admin'
}

async function listTombstonedSoleOwnedOrgIds(
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

async function hardPurgeOrgIfPresent(env: Env, orgId: OwnerId) {
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

export async function executeAdminAccountHardDelete(input: {
	env: Env
	actor: Actor
	targetStableUserId: string
	acknowledge: boolean
	path: string
}): Promise<{ handle: string }> {
	let target = await loadDeletionTarget(input.env.APP_DB, {
		stableUserId: input.targetStableUserId,
	})
	const resuming = !target
	if (!target) {
		target = await loadTombstonedDeletionTarget(
			input.env.APP_DB,
			input.targetStableUserId,
		)
	}
	if (!target) {
		throw new AdminAccountHardDeleteError('User not found.', 404, 'not_found')
	}
	let demotedAdmin = false
	if (!resuming) {
		const summary = await summarize(input.env, target)
		if (summary.acknowledgementRequired && !input.acknowledge) {
			await auditDeletion({
				env: input.env,
				actor: input.actor,
				target,
				path: input.path,
				result: 'failure',
				reason: `acknowledgement_required:${summary.acknowledgementReasons.join(',')}`,
			})
			throw new AdminAccountHardDeleteError(
				'Deleting this account requires acknowledging the packages, organizations, or paid billing on the confirmation page.',
				409,
				'acknowledgement_required',
			)
		}
		const adminSlot = await releaseAdminRoleIfNotLast(
			input.env.APP_DB,
			target.dbUserId,
		)
		if (adminSlot === 'last_admin') {
			await auditDeletion({
				env: input.env,
				actor: input.actor,
				target,
				path: input.path,
				result: 'failure',
				reason: 'last_admin',
			})
			throw new AdminAccountHardDeleteError(lastAdminMessage, 409, 'last_admin')
		}
		demotedAdmin = adminSlot === 'demoted'
	}

	try {
		if (!resuming) {
			for (const org of target.soleOwnedNonPersonalOrgs) {
				if (org.otherMemberCount === 0) continue
				await softDeleteOrg({
					env: input.env,
					orgId: org.orgId,
					actorUserId: input.actor.stableUserId,
					actorUsername: input.actor.username,
				})
			}
		}
		const softDeleted = await softDeleteUserAccount({
			env: input.env,
			userId: target.stableUserId,
			actorUserId: input.actor.stableUserId,
			actorUsername: input.actor.username,
		})
		const tombstonedSoleOwned = await listTombstonedSoleOwnedOrgIds(
			input.env.APP_DB,
			target.stableUserId,
			target.personalOrgId,
		)
		const orgIds = new Set<string>([
			...softDeleted.deletedOrgIds,
			...tombstonedSoleOwned,
			target.personalOrgId,
		])
		const ordered = [...orgIds].filter(
			(orgId) => orgId !== target.personalOrgId,
		)
		ordered.push(target.personalOrgId)
		for (const orgId of ordered) {
			await hardPurgeOrgIfPresent(input.env, ownerIdFromStored(orgId))
		}
		await hardPurgeSoftDeletedUser({
			env: input.env,
			dbUserId: target.dbUserId,
			stableUserId: target.stableUserId,
		})
	} catch (error) {
		if (demotedAdmin) {
			const stillThere = await input.env.APP_DB.prepare(
				`SELECT 1 AS ok FROM users WHERE id = ?`,
			)
				.bind(target.dbUserId)
				.first<{ ok: number }>()
			if (stillThere) {
				await assignUserRole({
					db: input.env.APP_DB,
					userId: target.dbUserId,
					roleName: 'admin',
				})
			}
		}
		const message =
			error instanceof UserDeleteBlockedSoleOwnerError
				? `Account deletion is blocked while this person is the only Owner of ${error.blockers
						.map((blocker) => `@${blocker.orgSlug}`)
						.join(
							', ',
						)} and other members remain. Promote another Owner or remove the other members first.`
				: error instanceof AccountDeletionInventoryError
					? error.inventoryErrors.join('; ')
					: error instanceof AccountDeletionCleanupError
						? error.cleanupErrors.join('; ')
						: error instanceof Error
							? error.message
							: 'Account deletion failed.'
		await auditDeletion({
			env: input.env,
			actor: input.actor,
			target,
			path: input.path,
			result: 'failure',
			reason: message.slice(0, 240),
		})
		if (error instanceof AdminAccountHardDeleteError) throw error
		throw new AdminAccountHardDeleteError(
			error instanceof UserDeleteBlockedSoleOwnerError
				? message
				: `Account deletion did not finish. Retry the same confirmation to finish freeing @${target.handle}. ${message}`,
			error instanceof UserDeleteBlockedSoleOwnerError ? 409 : 500,
			error instanceof UserDeleteBlockedSoleOwnerError
				? 'acknowledgement_required'
				: 'cleanup_failed',
		)
	}

	await auditDeletion({
		env: input.env,
		actor: input.actor,
		target,
		path: input.path,
		result: 'success',
		reason: `handle=${target.handle};acknowledged=${input.acknowledge}`,
	})
	scheduleUserDeletedEvent({
		env: input.env,
		user: {
			id: target.stableUserId,
			username: target.handle,
			email: target.email,
		},
	})
	return { handle: target.handle }
}

export async function createAdminAccountDeletionApproval(input: {
	env: Env
	actor: Actor
	target: AdminUserTarget
	now?: Date
}) {
	const loaded = await loadDeletionTarget(input.env.APP_DB, input.target)
	if (!loaded) {
		throw new AdminAccountHardDeleteError('User not found.', 404, 'not_found')
	}
	const summary = await summarize(input.env, loaded)
	if (summary.deletionBlocked) {
		throw new AdminAccountHardDeleteError(
			summary.deletionBlocked,
			409,
			'last_admin',
		)
	}
	const now = input.now ?? new Date()
	const approvalId = crypto.randomUUID()
	const expiresAt = new Date(
		now.getTime() + adminAccountDeletionApprovalTtlMs,
	).toISOString()
	await input.env.APP_DB.prepare(
		`INSERT INTO admin_account_deletion_approvals (
			id, target_stable_user_id, requested_by_stable_user_id, created_at, expires_at
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			approvalId,
			loaded.stableUserId,
			input.actor.stableUserId,
			now.toISOString(),
			expiresAt,
		)
		.run()
	return { approvalId, expiresAt, summary }
}

type ApprovalRow = {
	id: string
	target_stable_user_id: string
	expires_at: string
	consumed_at: string | null
}

export async function readAdminAccountDeletionApproval(input: {
	env: Env
	approvalId: string
	now?: Date
}): Promise<AdminAccountDeletionApprovalState> {
	const row = await input.env.APP_DB.prepare(
		`SELECT id, target_stable_user_id, expires_at, consumed_at
		 FROM admin_account_deletion_approvals
		 WHERE id = ?`,
	)
		.bind(input.approvalId)
		.first<ApprovalRow>()
	if (!row) return { status: 'missing' }
	if (row.consumed_at) return { status: 'consumed' }
	const now = input.now ?? new Date()
	if (Date.parse(row.expires_at) <= now.getTime()) return { status: 'expired' }
	const summary = await loadApprovalSummary(
		input.env,
		row.target_stable_user_id,
	)
	if (!summary) return { status: 'missing' }
	return { status: 'pending', summary }
}

async function claimApproval(input: {
	db: D1Database
	approvalId: string
	nowIso: string
}) {
	const claim = await input.db
		.prepare(
			`UPDATE admin_account_deletion_approvals
			 SET consumed_at = ?
			 WHERE id = ?
			   AND consumed_at IS NULL
			   AND expires_at > ?`,
		)
		.bind(input.nowIso, input.approvalId, input.nowIso)
		.run()
	return (claim.meta.changes ?? 0) === 1
}

async function releaseApproval(input: {
	db: D1Database
	approvalId: string
	consumedAt: string
}) {
	await input.db
		.prepare(
			`UPDATE admin_account_deletion_approvals
			 SET consumed_at = NULL
			 WHERE id = ? AND consumed_at = ?`,
		)
		.bind(input.approvalId, input.consumedAt)
		.run()
}

export async function approveAdminAccountDeletion(input: {
	env: Env
	actor: Actor
	approvalId: string
	acknowledge: boolean
	now?: Date
}) {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const row = await input.env.APP_DB.prepare(
		`SELECT id, target_stable_user_id, expires_at, consumed_at
		 FROM admin_account_deletion_approvals
		 WHERE id = ?`,
	)
		.bind(input.approvalId)
		.first<ApprovalRow>()
	if (!row || row.consumed_at || Date.parse(row.expires_at) <= now.getTime()) {
		throw new AdminAccountHardDeleteError(
			'This approval link is no longer valid. Request a new one.',
			409,
			'approval_invalid',
		)
	}
	const claimed = await claimApproval({
		db: input.env.APP_DB,
		approvalId: input.approvalId,
		nowIso,
	})
	if (!claimed) {
		throw new AdminAccountHardDeleteError(
			'This approval link is no longer valid. Request a new one.',
			409,
			'approval_invalid',
		)
	}
	try {
		return await executeAdminAccountHardDelete({
			env: input.env,
			actor: input.actor,
			targetStableUserId: row.target_stable_user_id,
			acknowledge: input.acknowledge,
			path: '/admin/account-deletions',
		})
	} catch (error) {
		await releaseApproval({
			db: input.env.APP_DB,
			approvalId: input.approvalId,
			consumedAt: nowIso,
		})
		throw error
	}
}

type WebsiteActor = Actor & { roles: ReadonlyArray<string> }

function requireAdminActor(actor: WebsiteActor) {
	if (!actor.roles.includes('admin')) {
		return adminOperationResult(
			{ ok: false as const, error: 'Admin role is required.' },
			403,
		)
	}
	return null
}

export async function readAdminAccountDeletionSummaryForActor(input: {
	env: Env
	actor: WebsiteActor
	stableUserId: string
}) {
	const denied = requireAdminActor(input.actor)
	if (denied) return denied
	const summary = await loadAdminAccountDeletionSummary(input.env, {
		stableUserId: input.stableUserId,
	})
	if (!summary) {
		return adminOperationResult(
			{ ok: false as const, error: 'User not found.' },
			404,
		)
	}
	return { ok: true as const, summary }
}

export async function deleteAdminUserAccount(input: {
	env: Env
	actor: WebsiteActor
	stableUserId: string
	handleConfirmation: string
	acknowledge: boolean
}) {
	const denied = requireAdminActor(input.actor)
	if (denied) return denied
	const summary =
		(await loadAdminAccountDeletionSummary(input.env, {
			stableUserId: input.stableUserId,
		})) ??
		(await loadTombstonedDeletionTarget(
			input.env.APP_DB,
			input.stableUserId,
		).then((tombstone) =>
			tombstone
				? {
						handle: tombstone.handle,
						email: tombstone.email,
					}
				: null,
		))
	if (!summary) {
		return adminOperationResult(
			{ ok: false as const, error: 'User not found.' },
			404,
		)
	}
	if (
		!adminAccountDeletionHandleMatches(summary.handle, input.handleConfirmation)
	) {
		await auditDeletion({
			env: input.env,
			actor: input.actor,
			target: { stableUserId: input.stableUserId, email: summary.email },
			path: '/admin/users',
			result: 'failure',
			reason: 'handle_mismatch',
		})
		return adminOperationResult(
			{
				ok: false as const,
				error: `Type @${summary.handle} to confirm deletion.`,
			},
			400,
		)
	}
	try {
		const deleted = await executeAdminAccountHardDelete({
			env: input.env,
			actor: input.actor,
			targetStableUserId: input.stableUserId,
			acknowledge: input.acknowledge,
			path: '/admin/users',
		})
		return { ok: true as const, handle: deleted.handle }
	} catch (error) {
		if (error instanceof AdminAccountHardDeleteError) {
			return adminOperationResult(
				{ ok: false as const, error: error.message },
				error.status,
			)
		}
		throw error
	}
}

export async function approveAdminAccountDeletionForActor(input: {
	env: Env
	actor: WebsiteActor
	approvalId: string
	acknowledge: boolean
}) {
	const denied = requireAdminActor(input.actor)
	if (denied) return denied
	try {
		const deleted = await approveAdminAccountDeletion({
			env: input.env,
			actor: input.actor,
			approvalId: input.approvalId,
			acknowledge: input.acknowledge,
		})
		return { ok: true as const, handle: deleted.handle }
	} catch (error) {
		if (error instanceof AdminAccountHardDeleteError) {
			return adminOperationResult(
				{ ok: false as const, error: error.message },
				error.status,
			)
		}
		throw error
	}
}
