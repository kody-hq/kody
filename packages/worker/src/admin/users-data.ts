import { invalidatePackageAppOwnerCache } from '#app/package-app-owner.ts'
import { updateOrgBillingColumns } from '#worker/orgs/org-billing-columns.ts'
import { d1ContainsLikePattern } from '#worker/d1-like-pattern.ts'
import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { readPagination } from '#worker/query-params.ts'
// Type-only: the admin payload envelopes are the app/client wire contract and
// are erased at build time, so this does not pull the app layer into the
// worker's runtime graph.
import { type AdminUsersLoaderData } from '#universal/loader-data.ts'
import { type RoleName, roleNames } from '#universal/permissions.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	planNames,
	resolveEntitlementLadderAfterPaidAccessChange,
	resolvePlanWrite,
	type EntitlementLadder,
	type PlanName,
} from '#universal/plans.ts'
import {
	resolveAdminPlanOverlay,
	type AdminPlanOverlayType,
} from '#universal/referral-program.ts'
import { resolveEffectivePlanWithSecondAgentGift } from '#universal/second-agent-standard-gift.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import {
	isAdminUserVerificationFilter,
	parseEmailVerificationDelivery,
	type AdminUserVerificationFilter,
	type EmailVerificationDelivery,
} from '#universal/email-verification-delivery.ts'
import {
	emailVerificationStallCutoffIso,
	emailVerificationStallSqlConditions,
} from '#worker/identity/email-verification-stall.ts'
import { forgiveCreditUsageBeforeUnlock } from '#worker/billing/credit-wallet.ts'
import {
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import {
	parsePersonId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const adminUserRowSelectSql = `u.id, u.stable_user_id, u.username, u.email, u.email_verified_at, COALESCE(o.plan, 'free') AS plan, o.stripe_plan, COALESCE(o.entitlement_ladder, 'public') AS entitlement_ladder, o.stripe_customer_id, u.suspended_at,
				o.email_outbound_paused_at, u.email_verification_delivery_status, u.email_verification_delivery_at, u.email_verification_delivery_detail, u.email_verification_delivery_class,
				u.utm_source, u.utm_medium, u.utm_campaign, u.utm_content, u.utm_term, u.first_touch_landing_path, u.first_touch_referrer,
				u.first_mcp_connected_at, u.first_execute_at, u.first_search_at, u.first_saved_package_at, u.mcp_client_name, u.last_active_at,
				o.second_agent_standard_gift_expires_at, o.referral_standard_credit_expires_at, u.created_at, u.updated_at`

const adminUsersFromSql = `users u LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AND o.deleted_at IS NULL`

export const adminUserListItemFieldNames = [
	'stableUserId',
	'username',
	'email',
	'email_verified',
	'email_verified_at',
	'plan',
	'manualPlan',
	'stripePlan',
	'effectivePlan',
	'secondAgentGiftExpiresAt',
	'referralCreditExpiresAt',
	'overlayExpiresAt',
	'isProOverlay',
	'overlayType',
	'entitlementLadder',
	'stripeCustomerLinked',
	'suspended_at',
	'email_outbound_paused_at',
	'email_verification_delivery',
	'email_verification_delivery_detail',
	'utm_source',
	'utm_medium',
	'utm_campaign',
	'utm_content',
	'utm_term',
	'first_touch_landing_path',
	'first_touch_referrer',
	'first_mcp_connected_at',
	'first_execute_at',
	'first_search_at',
	'first_saved_package_at',
	'mcp_client_name',
	'last_active_at',
	'created_at',
	'updated_at',
	'roles',
] as const

export type AdminUserListItemFieldName =
	(typeof adminUserListItemFieldNames)[number]

export type AdminUserListItem = Record<AdminUserListItemFieldName, unknown> & {
	stableUserId: OwnerId
	username: string
	email: string
	email_verified: boolean
	email_verified_at: string | null
	plan: PlanName
	manualPlan: PlanName
	stripePlan: PlanName | null
	effectivePlan: PlanName
	secondAgentGiftExpiresAt: string | null
	referralCreditExpiresAt: string | null
	overlayExpiresAt: string | null
	isProOverlay: boolean
	overlayType: AdminPlanOverlayType | null
	entitlementLadder: EntitlementLadder
	stripeCustomerLinked: boolean
	suspended_at: string | null
	email_outbound_paused_at: string | null
	email_verification_delivery: EmailVerificationDelivery | null
	email_verification_delivery_detail: string | null
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	first_touch_landing_path: string | null
	first_touch_referrer: string | null
	first_mcp_connected_at: string | null
	first_execute_at: string | null
	first_search_at: string | null
	first_saved_package_at: string | null
	mcp_client_name: string | null
	last_active_at: string | null
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

const adminUsersBasePath = '/admin/users'
const defaultPageSize = 20
const maxPageSize = 100

type AdminUserListFilters = {
	query: string
	role: RoleName | null
	verification: AdminUserVerificationFilter | null
}

/**
 * Resolve the selected account's stable id from an HTML path param, a detail
 * pathname, or the JSON API's `?selected=` query (in that order). Invalid
 * values yield null so the client can show "User not found."
 */
export function readAdminUsersSelectedStableUserId(
	requestUrl: string,
	pathStableUserId?: string,
): string | null {
	const fromPathParam = parseSelectedStableUserId(pathStableUserId)
	if (fromPathParam != null) return fromPathParam

	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${adminUsersBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = decodePathSegment(url.pathname.slice(detailPrefix.length))
		if (segment && !segment.includes('/')) {
			const fromPath = parseSelectedStableUserId(segment)
			if (fromPath != null) return fromPath
		}
	}

	return parseSelectedStableUserId(url.searchParams.get('selected'))
}

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		// Malformed percent-encoding (e.g. a literal `%`) must not throw;
		// the raw segment simply fails stable-id parsing below.
		return value
	}
}

function parseSelectedStableUserId(
	value: string | null | undefined,
): string | null {
	return parsePersonId(value)
}

/** Read the `q`, `role`, and `verification` filter query params. */
function readAdminUserListFilters(url: URL): AdminUserListFilters {
	const rawRole = url.searchParams.get('role')?.trim() ?? ''
	const rawVerification = url.searchParams.get('verification')?.trim() ?? ''
	return {
		query: url.searchParams.get('q')?.trim() ?? '',
		role: isRoleName(rawRole) ? rawRole : null,
		verification: isAdminUserVerificationFilter(rawVerification)
			? rawVerification
			: null,
	}
}

/**
 * Build the WHERE clause shared by the page query and its COUNT so the
 * reported total always matches the filtered result set.
 */
function buildAdminUserListWhereClause(
	filters: AdminUserListFilters,
	now: Date,
) {
	const conditions: Array<string> = ['u.deleted_at IS NULL']
	const params: Array<string> = []
	if (filters.query) {
		const pattern = d1ContainsLikePattern(filters.query)
		conditions.push(
			`(u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`,
		)
		params.push(pattern, pattern)
	}
	if (filters.role) {
		conditions.push(
			`u.id IN (SELECT ur.user_id FROM user_roles ur INNER JOIN roles r ON r.id = ur.role_id WHERE r.name = ?)`,
		)
		params.push(filters.role)
	}
	if (filters.verification) {
		switch (filters.verification) {
			case 'stalled':
				conditions.push(...emailVerificationStallSqlConditions('u'))
				params.push(emailVerificationStallCutoffIso(now))
				break
			default: {
				const exhaustive: never = filters.verification
				void exhaustive
			}
		}
	}
	return {
		whereClause:
			conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
		params,
	}
}

export async function loadAdminUsersData(
	env: Env,
	requestUrl: string,
	pathStableUserId?: string,
): Promise<AdminUsersLoaderData> {
	const url = new URL(requestUrl, 'http://localhost')
	const { page, pageSize } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	return readAdminUsersData(env, {
		...readAdminUserListFilters(url),
		page,
		pageSize,
		selectedStableUserId: readAdminUsersSelectedStableUserId(
			requestUrl,
			pathStableUserId,
		),
	})
}

/** The domain read accepts data, independent of page URLs or HTTP transport. */
export async function readAdminUsersData(
	env: Env,
	input: {
		query: string
		role: string | null
		verification: string | null
		page: number
		pageSize: number
		selectedStableUserId?: string | null
	},
): Promise<AdminUsersLoaderData> {
	const page = Math.max(1, Math.floor(input.page))
	const pageSize = Math.min(
		maxPageSize,
		Math.max(1, Math.floor(input.pageSize)),
	)
	const offset = (page - 1) * pageSize
	const role = input.role?.trim() ?? ''
	const verification = input.verification?.trim() ?? ''
	const filters: AdminUserListFilters = {
		query: input.query.trim(),
		role: isRoleName(role) ? role : null,
		verification: isAdminUserVerificationFilter(verification)
			? verification
			: null,
	}

	const { whereClause, params } = buildAdminUserListWhereClause(
		filters,
		new Date(),
	)
	const selectedStableUserId = parseSelectedStableUserId(
		input.selectedStableUserId,
	)

	const [totalResult, userRows, selectedUser] = await Promise.all([
		env.APP_DB.prepare(
			`SELECT COUNT(*) AS total FROM users u ${whereClause}${andLiveDeletedAtSql('u')}`,
		)
			.bind(...params)
			.first<{ total: number }>(),
		env.APP_DB.prepare(
			`SELECT ${adminUserRowSelectSql}
			 FROM ${adminUsersFromSql}
			 ${whereClause}${andLiveDeletedAtSql('u')}
			 ORDER BY u.id ASC
			 LIMIT ? OFFSET ?`,
		)
			.bind(...params, pageSize, offset)
			.all<AdminUserRow>(),
		selectedStableUserId
			? loadAdminUserByTarget(env.APP_DB, {
					stableUserId: selectedStableUserId,
				})
			: Promise.resolve(null),
	])
	const total = totalResult?.total ?? 0

	const userIds = (userRows.results ?? []).map((row) => row.id)
	const rolesByUserId = await loadRolesByUserIds(env.APP_DB, userIds)

	return {
		ok: true,
		users: (userRows.results ?? []).map((row) =>
			toAdminUserListItem(row, rolesByUserId.get(row.id) ?? []),
		),
		selectedUser,
		page,
		pageSize,
		total,
		availableRoles: [...roleNames],
		availablePlans: [...planNames],
	}
}

export type AdminUserTarget = {
	stableUserId?: string
	email?: string
	username?: string
}

export async function loadAdminUserByTarget(
	db: D1Database,
	input: AdminUserTarget,
): Promise<AdminUserListItem | null> {
	const stableUserId = parsePersonId(input.stableUserId)
	const email = input.email?.trim() ?? ''
	const username = input.username?.trim() ?? ''
	if (input.stableUserId !== undefined && !stableUserId) {
		return null
	}
	const userRow = stableUserId
		? await db
				.prepare(
					`SELECT ${adminUserRowSelectSql}
					 FROM ${adminUsersFromSql}
					 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
				)
				.bind(stableUserId)
				.first<AdminUserRow>()
		: email
			? await db
					.prepare(
						`SELECT ${adminUserRowSelectSql}
						 FROM ${adminUsersFromSql}
						 WHERE u.email = ? COLLATE NOCASE${andLiveDeletedAtSql('u')}`,
					)
					.bind(email)
					.first<AdminUserRow>()
			: username
				? await db
						.prepare(
							`SELECT ${adminUserRowSelectSql}
							 FROM ${adminUsersFromSql}
							 WHERE u.username = ? COLLATE NOCASE${andLiveDeletedAtSql('u')}`,
						)
						.bind(username)
						.first<AdminUserRow>()
				: null
	if (!userRow) return null

	const rolesByUserId = await loadRolesByUserIds(db, [userRow.id])
	return toAdminUserListItem(userRow, rolesByUserId.get(userRow.id) ?? [])
}

/**
 * Set the manual entitlement grant on the person's personal org (`orgs.plan`).
 * Nullish inputs map to `free`, the normal default; writers never persist
 * NULL. Stripe subscriptions stay on `orgs.stripe_plan`. A change that unlocks
 * an admin-eligible credit wallet forgives locked-period usage first. Returns
 * the updated account metadata record, or null when no user matches the target.
 */
export async function updateAdminUserPlan(
	db: D1Database,
	input: AdminUserTarget & { plan: PlanName | null; now?: Date },
): Promise<AdminUserListItem | null> {
	const existing = await loadAdminUserByTarget(db, input)
	if (!existing) return null
	const existingRow = await loadAdminUserRowByStableUserId(
		db,
		existing.stableUserId,
	)
	if (!existingRow) return null

	const now = input.now ?? new Date()
	const nextPlan = resolvePlanWrite(input.plan)
	const stripePlan = parseStripePlanName(existingRow.stripe_plan)
	const nextLadder = resolveEntitlementLadderAfterPaidAccessChange({
		currentLadder: parseEntitlementLadder(existingRow.entitlement_ladder),
		manualPlan: nextPlan,
		previousStripePlan: stripePlan,
		nextStripePlan: stripePlan,
	})
	const entitlementRow = await db
		.prepare(
			`SELECT ${userEntitlementColumnsSql()} FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(existing.stableUserId)
		.first<UserEntitlementRow>()
	if (entitlementRow) {
		await forgiveCreditUsageBeforeUnlock({
			db,
			userId: existing.stableUserId,
			current: entitlementRow,
			next: {
				...entitlementRow,
				plan: nextPlan,
				entitlement_ladder: nextLadder,
			},
			now,
		})
	}
	const updatedAt = utcSqliteTimestamp(now)
	const planWrite = await updateOrgBillingColumns({
		db,
		orgId: existing.stableUserId,
		setClause: 'plan = ?, entitlement_ladder = ?, updated_at = ?',
		values: [nextPlan, nextLadder, updatedAt],
	})
	if ((planWrite.meta.changes ?? 0) === 0) {
		throw new Error(
			`Cannot update billing: missing personal org ${existing.stableUserId}.`,
		)
	}

	return loadAdminUserByTarget(db, { stableUserId: existing.stableUserId })
}

/**
 * Set or clear the platform suspension on one user account. Suspension is
 * fail-closed at the browser-session, MCP, and email chokepoints; clearing
 * it restores normal access on the next request. Returns the updated
 * account metadata record, or null when no user matches `id`.
 */
export async function updateAdminUserSuspension(
	db: D1Database,
	input: { stableUserId: string; suspended: boolean },
): Promise<AdminUserListItem | null> {
	const existing = await loadAdminUserRowByStableUserId(db, input.stableUserId)
	if (!existing) return null

	const now = utcSqliteTimestamp()
	await db
		.prepare(
			`UPDATE users SET suspended_at = ?, updated_at = ? WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.suspended ? now : null, now, existing.id)
		.run()

	invalidatePackageAppOwnerCache({ stableUserId: input.stableUserId })

	return loadAdminUserByTarget(db, { stableUserId: input.stableUserId })
}

/**
 * Clear an automatic outbound-email pause (set by the delivery-event abuse
 * monitor) after operator review. Returns the updated account metadata
 * record, or null when no user matches `id`.
 */
export async function clearAdminUserEmailOutboundPause(
	db: D1Database,
	input: { stableUserId: string },
): Promise<AdminUserListItem | null> {
	const existing = await loadAdminUserRowByStableUserId(db, input.stableUserId)
	if (!existing) return null

	await updateOrgBillingColumns({
		db,
		orgId: input.stableUserId,
		setClause: 'email_outbound_paused_at = NULL, updated_at = ?',
		values: [utcSqliteTimestamp()],
	})

	return loadAdminUserByTarget(db, { stableUserId: input.stableUserId })
}

export async function loadRolesByUserIds(
	db: D1Database,
	userIds: Array<number>,
) {
	const rolesByUserId = new Map<number, Array<RoleName>>()
	if (userIds.length === 0) {
		return rolesByUserId
	}

	// A 100-user admin page hits D1's per-statement bound parameter cap, so
	// split the IN list across statements.
	for (const chunk of chunkArray(userIds, maxD1BoundParameters)) {
		const placeholders = chunk.map(() => '?').join(', ')
		const result = await db
			.prepare(
				`SELECT ur.user_id, r.name AS role_name
				 FROM user_roles ur
				 INNER JOIN roles r ON r.id = ur.role_id
				 WHERE ur.user_id IN (${placeholders})
				 ORDER BY ur.user_id ASC, r.name ASC`,
			)
			.bind(...chunk)
			.all<{ user_id: number; role_name: string }>()

		for (const row of result.results ?? []) {
			if (!isRoleName(row.role_name)) continue
			const current = rolesByUserId.get(row.user_id) ?? []
			current.push(row.role_name)
			rolesByUserId.set(row.user_id, current)
		}
	}

	return rolesByUserId
}

type AdminUserRow = {
	id: number
	stable_user_id: OwnerId
	username: string
	email: string
	email_verified_at: string | null
	plan: string
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_customer_id: string | null
	suspended_at: string | null
	email_outbound_paused_at: string | null
	email_verification_delivery_status: string | null
	email_verification_delivery_at: string | null
	email_verification_delivery_detail: string | null
	email_verification_delivery_class: string | null
	utm_source: string | null
	utm_medium: string | null
	utm_campaign: string | null
	utm_content: string | null
	utm_term: string | null
	first_touch_landing_path: string | null
	first_touch_referrer: string | null
	first_mcp_connected_at: string | null
	first_execute_at: string | null
	first_search_at: string | null
	first_saved_package_at: string | null
	mcp_client_name: string | null
	last_active_at: string | null
	second_agent_standard_gift_expires_at: string | null
	referral_standard_credit_expires_at: string | null
	created_at: string
	updated_at: string
}

function toAdminUserListItem(
	row: AdminUserRow,
	roles: Array<RoleName>,
): AdminUserListItem {
	const manualPlan = parseStoredPlanName(row.plan)
	const stripePlan = parseStripePlanName(row.stripe_plan)
	const overlay = resolveAdminPlanOverlay({
		manualPlan,
		stripePlan: row.stripe_plan,
		secondAgentGiftExpiresAt: row.second_agent_standard_gift_expires_at,
		referralCreditExpiresAt: row.referral_standard_credit_expires_at,
	})
	return {
		stableUserId: row.stable_user_id,
		username: row.username,
		email: row.email,
		email_verified: Boolean(row.email_verified_at),
		email_verified_at: row.email_verified_at,
		plan: manualPlan,
		manualPlan,
		stripePlan,
		effectivePlan: resolveEffectivePlanWithSecondAgentGift(
			manualPlan,
			row.stripe_plan,
			overlay.overlayExpiresAt,
		),
		secondAgentGiftExpiresAt: overlay.secondAgentGiftExpiresAt,
		referralCreditExpiresAt: overlay.referralCreditExpiresAt,
		overlayExpiresAt: overlay.overlayExpiresAt,
		isProOverlay: overlay.isProOverlay,
		overlayType: overlay.overlayType,
		entitlementLadder: parseEntitlementLadder(row.entitlement_ladder),
		stripeCustomerLinked: Boolean(row.stripe_customer_id),
		suspended_at: row.suspended_at,
		email_outbound_paused_at: row.email_outbound_paused_at,
		email_verification_delivery: parseEmailVerificationDelivery({
			status: row.email_verification_delivery_status,
			class: row.email_verification_delivery_class,
			at: row.email_verification_delivery_at,
		}),
		email_verification_delivery_detail:
			row.email_verification_delivery_detail ?? null,
		utm_source: row.utm_source ?? null,
		utm_medium: row.utm_medium ?? null,
		utm_campaign: row.utm_campaign ?? null,
		utm_content: row.utm_content ?? null,
		utm_term: row.utm_term ?? null,
		first_touch_landing_path: row.first_touch_landing_path ?? null,
		first_touch_referrer: row.first_touch_referrer ?? null,
		first_mcp_connected_at: row.first_mcp_connected_at ?? null,
		first_execute_at: row.first_execute_at ?? null,
		first_search_at: row.first_search_at ?? null,
		first_saved_package_at: row.first_saved_package_at ?? null,
		mcp_client_name: row.mcp_client_name ?? null,
		last_active_at: row.last_active_at ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
		roles,
	}
}

export async function loadAdminUserRowByStableUserId(
	db: D1Database,
	stableUserId: string,
): Promise<AdminUserRow | null> {
	if (!parsePersonId(stableUserId)) return null
	return await db
		.prepare(
			`SELECT ${adminUserRowSelectSql}
			 FROM ${adminUsersFromSql}
			 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
		)
		.bind(stableUserId)
		.first<AdminUserRow>()
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}
