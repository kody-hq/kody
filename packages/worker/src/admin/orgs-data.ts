/**
 * soft-delete-read-filter: opt-out
 *
 * Admin organization inventory intentionally includes tombstones and deleted
 * memberships so operators can inspect restore state.
 */
import { d1ContainsLikePattern } from '#worker/d1-like-pattern.ts'
import { resolveEffectiveUserBudgetMicroUsd } from '#worker/orgs/billing.ts'
import {
	isWithinSoftDeleteRestoreWindow,
	softDeleteRestoreDeadlineIso,
} from '#worker/soft-delete/window.ts'
import { loadAdminCreditWalletByOrgId } from '#worker/admin/credit-grants.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	type EntitlementLadder,
	type PlanName,
} from '#universal/plans.ts'
import { resolveAdminPlanOverlay } from '#universal/referral-program.ts'
import { resolveEffectivePlanWithSecondAgentGift } from '#universal/second-agent-standard-gift.ts'
import { resolveUserPlanFromRow } from '#worker/entitlements/service.ts'
import { parseOwnerId } from '@kody-internal/shared/owner-person-ids.ts'

export type AdminOrgKind = 'personal' | 'team'
export type AdminOrgRole = 'owner' | 'member' | 'billing'
export type AdminOrgStatus = 'live' | 'deleted' | 'all'

export type AdminOrgListItem = {
	id: string
	slug: string
	displayName: string | null
	kind: AdminOrgKind
	manualPlan: PlanName
	stripePlan: PlanName | null
	effectivePlan: PlanName
	seats: number
	creditBalanceMicroUsd: number | null
	suspendedAt: string | null
	deletedAt: string | null
	deletingAt: string | null
	createdAt: string
}

export type AdminOrgMembershipItem = {
	orgId: string
	slug: string
	displayName: string | null
	kind: AdminOrgKind
	role: AdminOrgRole
	effectivePlan: PlanName
	seats: number
	membershipDeletedAt: string | null
	orgDeletedAt: string | null
}

export type AdminOrgDetail = {
	org: {
		id: string
		slug: string
		displayName: string | null
		kind: AdminOrgKind
		createdAt: string
		updatedAt: string
		suspendedAt: string | null
	}
	softDelete: {
		deletedAt: string | null
		deletingAt: string | null
		restoreDeadline: string | null
	} | null
	plan: {
		manualPlan: PlanName
		stripePlan: PlanName | null
		effectivePlan: PlanName
		entitlementLadder: EntitlementLadder
		stripeCustomerLinked: boolean
		adminCreditsEligible: boolean
		stripeCreditsEligible: boolean
		creditsEligible: boolean
	}
	seats: { live: number; billingOnly: number }
	members: Array<{
		stableUserId: string
		username: string
		role: AdminOrgRole
		joinedAt: string
		membershipDeletedAt: string | null
		userDeletedAt: string | null
		individualBudgetMicroUsd: number | null
		effectiveBudgetMicroUsd: number | null
	}>
	budgets: {
		defaultUserBudgetMicroUsd: number | null
		automationBudgetMicroUsd: number | null
	}
	wallet: {
		plan: PlanName
		eligible: boolean
		adminCreditsEligible: boolean
		unlocked: boolean
		balanceMicroUsd: number
		recent: AdminOrgWalletLedgerItem[]
	}
	teamsCount: number
}

export type AdminOrgWalletLedgerItem = {
	kind: 'top_up' | 'auto_refill' | 'admin_grant' | 'debit'
	amountMicroUsd: number
	description: string
	createdAt: string
	grantedByUsername: string | null
	note: string | null
}

export type AdminOrgsData = {
	items: Array<AdminOrgListItem>
	total: number
	page: number
	pageSize: number
}

const maxPageSize = 100
const personalOrgCondition =
	"COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) = o.id"
const liveSeatsSql = `(SELECT COUNT(*)
	FROM org_memberships sm
	INNER JOIN users su
		ON su.stable_user_id = sm.user_id
		AND su.deleted_at IS NULL
	WHERE sm.org_id = o.id
		AND sm.role IN ('owner', 'member')
		AND sm.deleted_at IS NULL)`
const billingOnlySql = `(SELECT COUNT(*)
	FROM org_memberships bm
	INNER JOIN users bu
		ON bu.stable_user_id = bm.user_id
		AND bu.deleted_at IS NULL
	WHERE bm.org_id = o.id
		AND bm.role = 'billing'
		AND bm.deleted_at IS NULL)`

function normalizePage(page: number, pageSize: number) {
	const normalizedPage = Math.max(1, Math.floor(page))
	const normalizedPageSize = Math.min(
		maxPageSize,
		Math.max(1, Math.floor(pageSize)),
	)
	return {
		page: normalizedPage,
		pageSize: normalizedPageSize,
		offset: (normalizedPage - 1) * normalizedPageSize,
	}
}

function orgKind(value: number | string | null | undefined): AdminOrgKind {
	return Number(value) === 1 ? 'personal' : 'team'
}

function storedPlan(
	manual: string,
	stripe: string | null,
	secondAgentGiftExpiresAt: string | null = null,
	referralCreditExpiresAt: string | null = null,
) {
	const manualPlan = parseStoredPlanName(manual)
	const stripePlan = parseStripePlanName(stripe)
	const overlay = resolveAdminPlanOverlay({
		manualPlan,
		stripePlan: stripe,
		secondAgentGiftExpiresAt,
		referralCreditExpiresAt,
	})
	return {
		manualPlan,
		stripePlan,
		effectivePlan: resolveEffectivePlanWithSecondAgentGift(
			manualPlan,
			stripe,
			overlay.overlayExpiresAt,
		),
	}
}

export async function readAdminOrgsData(
	db: D1Database,
	input: {
		query?: string
		status: AdminOrgStatus
		kind: AdminOrgKind | 'all'
		page: number
		pageSize: number
	},
): Promise<AdminOrgsData> {
	const { page, pageSize, offset } = normalizePage(input.page, input.pageSize)
	const conditions: Array<string> = []
	const params: Array<string> = []
	if (input.status === 'live') conditions.push('o.deleted_at IS NULL')
	if (input.status === 'deleted') conditions.push('o.deleted_at IS NOT NULL')
	if (input.kind !== 'all') {
		conditions.push(
			input.kind === 'personal'
				? `EXISTS (SELECT 1 FROM users u WHERE ${personalOrgCondition})`
				: `NOT EXISTS (SELECT 1 FROM users u WHERE ${personalOrgCondition})`,
		)
	}
	const query = input.query?.trim() ?? ''
	if (query) {
		const pattern = d1ContainsLikePattern(query)
		conditions.push(
			"(o.slug LIKE ? ESCAPE '\\' COLLATE NOCASE OR o.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE)",
		)
		params.push(pattern, pattern)
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
	const [countRow, rows] = await Promise.all([
		db
			.prepare(`SELECT COUNT(*) AS total FROM orgs o ${where}`)
			.bind(...params)
			.first<{ total: number }>(),
		db
			.prepare(
				`SELECT o.id, o.slug, o.display_name, o.plan, o.stripe_plan,
				        o.second_agent_standard_gift_expires_at,
				        o.referral_standard_credit_expires_at,
				        o.suspended_at, o.deleted_at, o.deleting_at, o.created_at,
				        EXISTS (SELECT 1 FROM users u WHERE ${personalOrgCondition}) AS is_personal,
				        ${liveSeatsSql} AS seats,
				        (SELECT cw.balance_micro_usd FROM credit_wallets cw
				         WHERE cw.user_id = o.id) AS credit_balance_micro_usd
				 FROM orgs o
				 ${where}
				 ORDER BY o.slug COLLATE NOCASE ASC
				 LIMIT ? OFFSET ?`,
			)
			.bind(...params, pageSize, offset)
			.all<{
				id: string
				slug: string
				display_name: string | null
				plan: string
				stripe_plan: string | null
				second_agent_standard_gift_expires_at: string | null
				referral_standard_credit_expires_at: string | null
				suspended_at: string | null
				deleted_at: string | null
				deleting_at: string | null
				created_at: string
				is_personal: number
				seats: number
				credit_balance_micro_usd: number | null
			}>(),
	])
	return {
		items: (rows.results ?? []).map((row) => ({
			id: row.id,
			slug: row.slug,
			displayName: row.display_name,
			kind: orgKind(row.is_personal),
			...storedPlan(
				row.plan,
				row.stripe_plan,
				row.second_agent_standard_gift_expires_at,
				row.referral_standard_credit_expires_at,
			),
			seats: row.seats,
			creditBalanceMicroUsd: row.credit_balance_micro_usd,
			suspendedAt: row.suspended_at,
			deletedAt: row.deleted_at,
			deletingAt: row.deleting_at,
			createdAt: row.created_at,
		})),
		total: countRow?.total ?? 0,
		page,
		pageSize,
	}
}

export async function listAdminUserOrgMemberships(
	db: D1Database,
	stableUserId: string,
): Promise<Array<AdminOrgMembershipItem>> {
	const rows = await db
		.prepare(
			`SELECT o.id AS org_id, o.slug, o.display_name, o.plan, o.stripe_plan,
			        o.second_agent_standard_gift_expires_at,
			        o.referral_standard_credit_expires_at,
			        o.deleted_at AS org_deleted_at, m.role, m.deleted_at AS membership_deleted_at,
			        EXISTS (SELECT 1 FROM users u WHERE ${personalOrgCondition}) AS is_personal,
			        ${liveSeatsSql} AS seats
			 FROM org_memberships m
			 INNER JOIN orgs o ON o.id = m.org_id
			 WHERE m.user_id = ?
			 ORDER BY is_personal DESC, (m.deleted_at IS NULL) DESC, o.slug COLLATE NOCASE ASC`,
		)
		.bind(stableUserId)
		.all<{
			org_id: string
			slug: string
			display_name: string | null
			plan: string
			stripe_plan: string | null
			second_agent_standard_gift_expires_at: string | null
			referral_standard_credit_expires_at: string | null
			org_deleted_at: string | null
			role: string
			membership_deleted_at: string | null
			is_personal: number
			seats: number
		}>()
	return (rows.results ?? []).flatMap((row) => {
		if (row.role !== 'owner' && row.role !== 'member' && row.role !== 'billing')
			return []
		return [
			{
				orgId: row.org_id,
				slug: row.slug,
				displayName: row.display_name,
				kind: orgKind(row.is_personal),
				role: row.role,
				effectivePlan: storedPlan(
					row.plan,
					row.stripe_plan,
					row.second_agent_standard_gift_expires_at,
					row.referral_standard_credit_expires_at,
				).effectivePlan,
				seats: row.seats,
				membershipDeletedAt: row.membership_deleted_at,
				orgDeletedAt: row.org_deleted_at,
			},
		]
	})
}

type OrgDetailRow = {
	id: string
	slug: string
	display_name: string | null
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_customer_id: string | null
	admin_credits_eligible: number | null
	stripe_credits_eligible: number | null
	second_agent_standard_gift_expires_at: string | null
	referral_standard_credit_expires_at: string | null
	default_user_budget_micro_usd: number | null
	automation_budget_micro_usd: number | null
	created_at: string
	updated_at: string
	suspended_at: string | null
	deleted_at: string | null
	deleting_at: string | null
	is_personal: number
	live_seats: number
	billing_only: number
	teams_count: number
}

export async function loadAdminOrgDetail(
	envOrDb: Env | D1Database,
	input: { slug?: string; orgId?: string },
): Promise<AdminOrgDetail | null> {
	const db = 'APP_DB' in envOrDb ? envOrDb.APP_DB : envOrDb
	const slug = input.slug?.trim().replace(/^@/, '').toLowerCase()
	const orgId = input.orgId ? parseOwnerId(input.orgId) : null
	if (!slug && !orgId) return null
	const row = await db
		.prepare(
			`SELECT o.id, o.slug, o.display_name, o.plan, o.stripe_plan,
			        o.entitlement_ladder, o.stripe_customer_id, o.admin_credits_eligible,
			        o.stripe_credits_eligible, o.second_agent_standard_gift_expires_at,
			        o.referral_standard_credit_expires_at, o.default_user_budget_micro_usd,
			        o.automation_budget_micro_usd, o.created_at, o.updated_at,
			        o.suspended_at, o.deleted_at, o.deleting_at,
			        EXISTS (SELECT 1 FROM users u WHERE ${personalOrgCondition}) AS is_personal,
			        ${liveSeatsSql} AS live_seats, ${billingOnlySql} AS billing_only,
			        (SELECT COUNT(*) FROM teams t WHERE t.org_id = o.id AND t.deleted_at IS NULL) AS teams_count
			 FROM orgs o
			 WHERE ${orgId ? 'o.id = ?' : 'lower(o.slug) = ?'}
			 LIMIT 1`,
		)
		.bind(orgId ?? slug)
		.first<OrgDetailRow>()
	if (!row) return null
	const members = await db
		.prepare(
			`SELECT m.user_id, COALESCE(u.username, 'Deleted user') AS username,
			        m.role, m.created_at AS joined_at, m.deleted_at AS membership_deleted_at,
			        u.deleted_at AS user_deleted_at, b.monthly_budget_micro_usd
			 FROM org_memberships m
			 LEFT JOIN users u ON u.stable_user_id = m.user_id
			 LEFT JOIN org_user_budgets b
			   ON b.org_id = m.org_id AND b.user_id = m.user_id AND b.deleted_at IS NULL
			 WHERE m.org_id = ?
			 ORDER BY (m.deleted_at IS NULL) DESC, username COLLATE NOCASE ASC`,
		)
		.bind(row.id)
		.all<{
			user_id: string
			username: string
			role: string
			joined_at: string
			membership_deleted_at: string | null
			user_deleted_at: string | null
			monthly_budget_micro_usd: number | null
		}>()
	const { manualPlan, stripePlan, effectivePlan } = storedPlan(
		row.plan,
		row.stripe_plan,
		row.second_agent_standard_gift_expires_at,
		row.referral_standard_credit_expires_at,
	)
	const walletRead = await loadAdminCreditWalletByOrgId(db, row.id)
	const wallet = walletRead ?? {
		plan: effectivePlan,
		eligible: false,
		adminCreditsEligible: Number(row.admin_credits_eligible) === 1,
		unlocked: false,
		balanceMicroUsd: 0,
		recent: [],
	}
	const entitlement = resolveUserPlanFromRow(row)
	const deletedAt = row.deleted_at
	const softDelete =
		deletedAt || row.deleting_at
			? {
					deletedAt,
					deletingAt: row.deleting_at,
					restoreDeadline: deletedAt
						? softDeleteRestoreDeadlineIso(deletedAt)
						: null,
				}
			: null
	return {
		org: {
			id: row.id,
			slug: row.slug,
			displayName: row.display_name,
			kind: orgKind(row.is_personal),
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			suspendedAt: row.suspended_at,
		},
		softDelete,
		plan: {
			manualPlan,
			stripePlan,
			effectivePlan,
			entitlementLadder: parseEntitlementLadder(row.entitlement_ladder),
			stripeCustomerLinked: Boolean(row.stripe_customer_id),
			adminCreditsEligible: Number(row.admin_credits_eligible) === 1,
			stripeCreditsEligible: Number(row.stripe_credits_eligible) === 1,
			creditsEligible: entitlement.creditsEligible,
		},
		seats: { live: row.live_seats, billingOnly: row.billing_only },
		members: (members.results ?? []).flatMap((member) => {
			if (
				member.role !== 'owner' &&
				member.role !== 'member' &&
				member.role !== 'billing'
			)
				return []
			const individualBudget = member.monthly_budget_micro_usd ?? null
			return [
				{
					stableUserId: member.user_id,
					username: member.username,
					role: member.role,
					joinedAt: member.joined_at,
					membershipDeletedAt: member.membership_deleted_at,
					userDeletedAt: member.user_deleted_at,
					individualBudgetMicroUsd: individualBudget,
					effectiveBudgetMicroUsd: resolveEffectiveUserBudgetMicroUsd({
						individualBudget,
						orgDefaultBudget: row.default_user_budget_micro_usd,
					}),
				},
			]
		}),
		budgets: {
			defaultUserBudgetMicroUsd: row.default_user_budget_micro_usd,
			automationBudgetMicroUsd: row.automation_budget_micro_usd,
		},
		wallet: {
			plan: wallet.plan,
			eligible: wallet.eligible,
			adminCreditsEligible: wallet.adminCreditsEligible,
			unlocked: wallet.unlocked,
			balanceMicroUsd: wallet.balanceMicroUsd,
			recent: wallet.recent.map((item) => ({
				kind: item.kind,
				amountMicroUsd: item.amountMicroUsd,
				description: item.description,
				createdAt: item.createdAt,
				grantedByUsername: item.grantedByUsername,
				note: item.note,
			})),
		},
		teamsCount: row.teams_count,
	}
}

export function adminOrgDeletedRestoreState(deletedAt: string | null) {
	return deletedAt
		? {
				restoreDeadline: softDeleteRestoreDeadlineIso(deletedAt),
				restorable: isWithinSoftDeleteRestoreWindow(deletedAt),
			}
		: null
}
