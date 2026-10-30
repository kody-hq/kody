import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import {
	creditAdminGrantNoteMaxLength,
	validateCreditAdminGrantCents,
} from '#universal/credits.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	resolveEntitlementLadderAfterPaidAccessChange,
	type PlanName,
} from '#universal/plans.ts'
import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	ensureCreditWallet,
	buildAdminCreditGrantStatements,
	forgiveCreditUsageBeforeUnlock,
} from '#worker/billing/credit-wallet.ts'
import {
	getUserEntitlement,
	invalidateCachedUserEntitlement,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import {
	countLiveFreeOwnedOrgs,
	FreeOrgLimitError,
	effectiveFreeOrgSql,
	isPaidOrgBilling,
	MAX_FREE_ORGS_PER_USER,
} from '#worker/orgs/billing.ts'
import {
	prepareOrgBillingUpdate,
	updateOrgBillingColumns,
} from '#worker/orgs/org-billing-columns.ts'
import {
	runAppDbBatchWithOrgAudit,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import {
	normalizeOrgLimitOverrideReason,
	resolveAdminOrgTarget,
	type AdminOrgTarget,
} from './org-limit-overrides.ts'

export const orgBillingAuditActions = {
	planSet: 'admin_plan_set',
	creditsGranted: 'admin_credits_granted',
	creditEligibilitySet: 'admin_credit_eligibility_set',
} as const

export const freeOrgCapDowngradeGuardSql = `
	AND NOT EXISTS (
		SELECT 1
		FROM org_memberships m
		INNER JOIN users u ON u.stable_user_id = m.user_id AND u.deleted_at IS NULL
		WHERE m.org_id = orgs.id
		  AND m.role = 'owner'
		  AND m.deleted_at IS NULL
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

const freeOrgDowngradeRaceMessage =
	'Downgrading this organization to free would give an Owner more than 2 free organizations. Make one of their organizations paid or delete one first.'

export class AdminOrgBillingMutationError extends Error {
	readonly status: 400 | 404

	constructor(status: 400 | 404, message: string) {
		super(message)
		this.name = 'AdminOrgBillingMutationError'
		this.status = status
	}
}

export type AdminOrgPlatformAudit =
	| { email: string; ip?: string; path: string }
	| false

export async function writeOrgManualPlan(input: {
	db: D1Database
	orgId: string
	plan: PlanName
	now: Date
	orgWhereSuffix?: string
	orgWhereValues?: ReadonlyArray<unknown>
	audit?: OrgAuditWriter
	auditEvent?: {
		action: string
		details: Record<string, unknown>
	}
}): Promise<void> {
	const row = await input.db
		.prepare(
			`SELECT ${userEntitlementColumnsSql()} FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId)
		.first<UserEntitlementRow>()
	if (!row) throw new AdminOrgBillingMutationError(404, 'Org not found.')
	const nextLadder = resolveEntitlementLadderAfterPaidAccessChange({
		currentLadder: parseEntitlementLadder(row.entitlement_ladder),
		manualPlan: input.plan,
		previousStripePlan: parseStripePlanName(row.stripe_plan),
		nextStripePlan: parseStripePlanName(row.stripe_plan),
	})
	await forgiveCreditUsageBeforeUnlock({
		db: input.db,
		userId: input.orgId,
		current: row,
		next: { ...row, plan: input.plan, entitlement_ladder: nextLadder },
		now: input.now,
	})
	const updatedAt = utcSqliteTimestamp(input.now)
	const setClause = 'plan = ?, entitlement_ladder = ?, updated_at = ?'
	const values = [input.plan, nextLadder, updatedAt]
	const orgWhereValues = input.orgWhereValues ?? []
	if (input.audit && input.auditEvent) {
		const result = await runAppDbBatchWithOrgAudit({
			appDb: input.db,
			audit: input.audit,
			statements: [
				prepareOrgBillingUpdate(
					input.db,
					input.orgId,
					setClause,
					values,
					input.orgWhereSuffix,
					orgWhereValues,
				),
			],
			onlyIfChanged: true,
			event: {
				orgId: input.orgId,
				action: input.auditEvent.action,
				resourceType: 'org_billing',
				resourceId: input.orgId,
				details: input.auditEvent.details,
			},
		})
		if (!result.changed) {
			await throwManualPlanWriteError({
				db: input.db,
				orgId: input.orgId,
				capGuarded: Boolean(input.orgWhereSuffix),
			})
		}
		return
	}
	const result = await updateOrgBillingColumns({
		db: input.db,
		orgId: input.orgId,
		setClause,
		values,
		orgWhereSuffix: input.orgWhereSuffix,
		orgWhereValues,
	})
	if ((result.meta.changes ?? 0) === 0) {
		await throwManualPlanWriteError({
			db: input.db,
			orgId: input.orgId,
			capGuarded: Boolean(input.orgWhereSuffix),
		})
	}
}

async function throwManualPlanWriteError(input: {
	db: D1Database
	orgId: string
	capGuarded: boolean
}): Promise<never> {
	if (input.capGuarded) {
		const liveOrg = await input.db
			.prepare(
				`SELECT 1 AS present FROM orgs WHERE id = ? AND deleted_at IS NULL`,
			)
			.bind(input.orgId)
			.first<{ present: number }>()
		if (liveOrg) throw new FreeOrgLimitError(freeOrgDowngradeRaceMessage)
	}
	throw new AdminOrgBillingMutationError(404, 'Org not found.')
}

export async function writeOrgCreditEligibility(input: {
	db: D1Database
	orgId: string
	creditsEligible: boolean
	now: Date
	audit?: OrgAuditWriter
	auditEvent?: {
		action: string
		details: Record<string, unknown>
	}
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT ${userEntitlementColumnsSql()} FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId)
		.first<UserEntitlementRow>()
	if (!row) throw new AdminOrgBillingMutationError(404, 'Org not found.')
	const previous = Number(row.admin_credits_eligible) === 1
	const next = input.creditsEligible ? 1 : 0
	await forgiveCreditUsageBeforeUnlock({
		db: input.db,
		userId: input.orgId,
		current: row,
		next: { ...row, admin_credits_eligible: next },
		now: input.now,
	})
	const statement = prepareOrgBillingUpdate(
		input.db,
		input.orgId,
		'admin_credits_eligible = ?, updated_at = ?',
		[next, utcSqliteTimestamp(input.now)],
	)
	if (input.audit && input.auditEvent) {
		const result = await runAppDbBatchWithOrgAudit({
			appDb: input.db,
			audit: input.audit,
			statements: [statement],
			onlyIfChanged: true,
			event: {
				orgId: input.orgId,
				action: input.auditEvent.action,
				resourceType: 'org_billing',
				resourceId: input.orgId,
				details: input.auditEvent.details,
			},
		})
		if (!result.changed)
			throw new AdminOrgBillingMutationError(404, 'Org not found.')
	} else {
		await statement.run()
	}
	return previous
}

async function writePlatformAudit(input: {
	env: Env
	audit: AdminOrgPlatformAudit | undefined
	action: string
	reason: string
}) {
	if (!input.audit) return
	await logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: input.action,
		result: 'success',
		email: input.audit.email,
		ip: input.audit.ip,
		path: input.audit.path,
		reason: input.reason,
	})
}

async function liveOwners(db: D1Database, orgId: string) {
	const owners = await db
		.prepare(
			`SELECT DISTINCT m.user_id, COALESCE(h.handle, u.username) AS handle
			 FROM org_memberships m
			 INNER JOIN users u
			   ON u.stable_user_id = m.user_id AND u.deleted_at IS NULL
			 LEFT JOIN handles h ON h.user_id = m.user_id
			 WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL`,
		)
		.bind(orgId)
		.all<{ user_id: string; handle: string | null }>()
	return owners.results ?? []
}

export async function setAdminOrgPlan(input: {
	env: Env
	audit: OrgAuditWriter
	target: AdminOrgTarget
	plan: PlanName
	reason: unknown
	platformAudit?: AdminOrgPlatformAudit
	now?: Date
}): Promise<{
	orgId: string
	previous: PlanName
	next: PlanName
	changed: boolean
}> {
	const reason = normalizeOrgLimitOverrideReason(input.reason)
	const db = input.env.APP_DB
	const org = await resolveAdminOrgTarget(db, input.target)
	const current = await db
		.prepare(
			`SELECT plan, stripe_plan FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(org.id)
		.first<{ plan: string | null; stripe_plan: string | null }>()
	if (!current) throw new AdminOrgBillingMutationError(404, 'Org not found.')
	const previous = parseStoredPlanName(current.plan)
	if (previous === input.plan) {
		return { orgId: org.id, previous, next: input.plan, changed: false }
	}
	const capRelevantDowngrade =
		input.plan === 'free' &&
		isPaidOrgBilling({ plan: previous, stripe_plan: current.stripe_plan }) &&
		!isPaidOrgBilling({ plan: 'free', stripe_plan: current.stripe_plan })
	if (capRelevantDowngrade) {
		for (const owner of await liveOwners(db, org.id)) {
			if (
				(await countLiveFreeOwnedOrgs(db, owner.user_id)) >=
				MAX_FREE_ORGS_PER_USER
			) {
				const who = owner.handle ? `@${owner.handle}` : 'an Owner'
				throw new FreeOrgLimitError(
					`Downgrading this organization to free would give ${who} more than 2 free organizations. Make one of their organizations paid or delete one first.`,
				)
			}
		}
	}
	const now = input.now ?? new Date()
	await writeOrgManualPlan({
		db,
		orgId: org.id,
		plan: input.plan,
		now,
		orgWhereSuffix: capRelevantDowngrade
			? freeOrgCapDowngradeGuardSql
			: undefined,
		orgWhereValues: capRelevantDowngrade ? [MAX_FREE_ORGS_PER_USER] : undefined,
		audit: input.audit,
		auditEvent: {
			action: orgBillingAuditActions.planSet,
			details: { previous, next: input.plan, reason },
		},
	})
	invalidateCachedUserEntitlement(db, org.id)
	await writePlatformAudit({
		env: input.env,
		audit: input.platformAudit,
		action: 'adminOrgPlanSet',
		reason: `org_id=${org.id};plan=${input.plan};previous=${previous};reason=${reason}`,
	})
	return { orgId: org.id, previous, next: input.plan, changed: true }
}

export async function grantAdminCreditsToOrg(input: {
	env: Env
	audit: OrgAuditWriter
	target: AdminOrgTarget
	grantedBy: { stableUserId: string; email: string }
	amountCents: unknown
	reason: unknown
	platformAudit?: AdminOrgPlatformAudit
	now?: Date
}): Promise<{ orgId: string; entryId: string; amountCents: number }> {
	const normalized = validateCreditAdminGrantCents(input.amountCents)
	if (!normalized.ok) {
		throw new AdminOrgBillingMutationError(400, normalized.error)
	}
	const reason = normalizeOrgLimitOverrideReason(
		input.reason,
		creditAdminGrantNoteMaxLength,
	)
	const db = input.env.APP_DB
	const org = await resolveAdminOrgTarget(db, input.target)
	const now = input.now ?? new Date()
	const entitlement = await getUserEntitlement(db, {
		userId: org.id,
		email: null,
	})
	await ensureCreditWallet({ db, userId: org.id, entitlement, now })
	const grant = await buildAdminCreditGrantStatements({
		db,
		recipientUserId: org.id,
		grantedByUserId: input.grantedBy.stableUserId,
		amountCents: normalized.cents,
		note: reason,
		now,
	})
	await runAppDbBatchWithOrgAudit({
		appDb: db,
		audit: input.audit,
		statements: grant.statements,
		event: {
			orgId: org.id,
			action: orgBillingAuditActions.creditsGranted,
			resourceType: 'credit_wallet',
			resourceId: grant.entryId,
			details: {
				amountCents: normalized.cents,
				entryId: grant.entryId,
				reason,
			},
		},
	})
	invalidateCachedUserEntitlement(db, org.id)
	await writePlatformAudit({
		env: input.env,
		audit: input.platformAudit,
		action: 'adminOrgCreditGrant',
		reason: `org_id=${org.id};amount_cents=${normalized.cents};entry_id=${grant.entryId};reason=${reason}`,
	})
	return {
		orgId: org.id,
		entryId: grant.entryId,
		amountCents: normalized.cents,
	}
}

export async function setAdminOrgCreditEligibility(input: {
	env: Env
	audit: OrgAuditWriter
	target: AdminOrgTarget
	creditsEligible: boolean
	reason: unknown
	platformAudit?: AdminOrgPlatformAudit
	now?: Date
}): Promise<{
	orgId: string
	previous: boolean
	next: boolean
	changed: boolean
}> {
	const reason = normalizeOrgLimitOverrideReason(input.reason)
	const db = input.env.APP_DB
	const org = await resolveAdminOrgTarget(db, input.target)
	const next = input.creditsEligible
	const current = await db
		.prepare(
			`SELECT admin_credits_eligible FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(org.id)
		.first<{ admin_credits_eligible: number | null }>()
	if (!current) throw new AdminOrgBillingMutationError(404, 'Org not found.')
	const previous = Number(current.admin_credits_eligible) === 1
	if (previous === next) {
		return { orgId: org.id, previous, next, changed: false }
	}
	await writeOrgCreditEligibility({
		db,
		orgId: org.id,
		creditsEligible: next,
		now: input.now ?? new Date(),
		audit: input.audit,
		auditEvent: {
			action: orgBillingAuditActions.creditEligibilitySet,
			details: { previous, next, reason },
		},
	})
	invalidateCachedUserEntitlement(db, org.id)
	await writePlatformAudit({
		env: input.env,
		audit: input.platformAudit,
		action: 'adminOrgCreditEligibilitySet',
		reason: `org_id=${org.id};credits_eligible=${next};previous=${previous};reason=${reason}`,
	})
	return { orgId: org.id, previous, next, changed: true }
}
