import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { waitUntil } from 'cloudflare:workers'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import {
	sendBillingSuccessEmail,
	sendPastDueEmail,
} from '#app/user-account-emails.ts'
import { readSignupOrgSlug } from '#worker/orgs/signup-org-slug.ts'
import { maybeSyncDiscordGuildRolesForUser } from '#worker/discord/guild-role.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	parseEntitlementLadder,
	parseStoredPlanName,
	parseStripePlanName,
	resolveEntitlementLadderAfterPaidAccessChange,
	type PlanName,
} from '#universal/plans.ts'
import {
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { forgiveCreditUsageBeforeUnlock } from '#worker/billing/credit-wallet.ts'
import { recordPromoClaimFromCheckoutSession } from '#worker/billing/checkout-promo.ts'
import {
	createBillingLinkReference,
	isBillingConfigured,
	resolveSubscriptionPlan,
	type ResolvedSubscriptionPlan,
} from './billing-config.ts'
import {
	BillingNotConfiguredError,
	getCheckoutSession,
	listSubscriptions,
	mergeStripeObjectMetadata,
	StripeApiError,
} from './stripe-client.ts'
import { scheduleStripePlanRefreshBackstop } from './stripe-plan-refresh-client.ts'
import { updateOrgBillingColumns } from '#worker/orgs/org-billing-columns.ts'
import { sendToOrgBillingRecipients } from './org-billing-emails.ts'
import {
	buildOrgBillingMetadata,
	resolveOrgIdFromStripeMetadata,
} from './org-stripe-metadata.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/**
 * Success often races `checkout.session.completed`. When the webhook already
 * linked and refreshed within this window, skip a second Stripe
 * `listSubscriptions`. Older `stripe_plan` values (canceled-then-resubscribe)
 * must still refresh.
 */
const checkoutLinkReplayFreshMs = 5 * 60 * 1000

export class BillingLinkError extends Error {
	readonly code:
		| 'billing_not_configured'
		| 'missing_session'
		| 'client_reference_mismatch'
		| 'missing_customer'
		| 'customer_already_linked'
		| 'account_already_linked'
		| 'stripe_error'
		| 'user_not_found'

	constructor(
		code: BillingLinkError['code'],
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options)
		this.name = 'BillingLinkError'
		this.code = code
	}
}

type BillingUser = {
	id: number
	email: string
	stableUserId: OwnerId
	/** Personal org OwnerId (may differ from stableUserId for new signups). */
	personalOrgId: OwnerId
}

type SyncEnv = Env

export async function refreshStripePlanForUser(input: {
	env: SyncEnv
	userId: number
	customerId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	const now = input.now ?? new Date()
	const previous = await input.env.APP_DB.prepare(
		`SELECT u.email, u.stable_user_id, o.id AS org_id, o.stripe_price_id,
		        ${userEntitlementColumnsSql('o')}
		 FROM users u
		 INNER JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
		 WHERE u.id = ?${andLiveDeletedAtSql('u')}${andLiveDeletedAtSql('o')}`,
	)
		.bind(input.userId)
		.first<
			UserEntitlementRow & {
				email: string
				stable_user_id: OwnerId
				org_id: OwnerId
				stripe_price_id: string | null
			}
		>()
	const subscriptions = await listSubscriptions(input.env, input.customerId)
	const resolved = resolveSubscriptionPlan(subscriptions, input.env)
	const nextLadder = previous
		? resolveEntitlementLadderAfterPaidAccessChange({
				currentLadder: parseEntitlementLadder(previous.entitlement_ladder),
				manualPlan: parseStoredPlanName(previous.plan),
				previousStripePlan: parseStripePlanName(previous.stripe_plan),
				nextStripePlan: resolved.stripePlan,
				previousStripePriceId: previous.stripe_price_id,
				nextStripePriceId: resolved.stripePriceId,
			})
		: 'public'
	if (previous) {
		await forgiveCreditUsageBeforeUnlock({
			db: input.env.APP_DB,
			userId: previous.org_id,
			current: previous,
			next: {
				...previous,
				stripe_plan: resolved.stripePlan,
				stripe_credits_eligible: resolved.creditsEligible ? 1 : 0,
				entitlement_ladder: nextLadder,
			},
			now,
		})
	}
	if (!previous?.org_id) {
		throw new Error(
			`Cannot refresh Stripe plan: missing personal org for user ${input.userId}.`,
		)
	}
	const stripePlanRefreshedAt = now.toISOString()
	const stripeCreditsEligible = resolved.creditsEligible ? 1 : 0
	await updateOrgBillingColumns({
		db: input.env.APP_DB,
		orgId: previous.org_id,
		setClause: `stripe_plan = ?, stripe_price_id = ?, stripe_credits_eligible = ?,
		     stripe_plan_refreshed_at = ?, entitlement_ladder = ?, updated_at = ?`,
		values: [
			resolved.stripePlan,
			resolved.stripePriceId,
			stripeCreditsEligible,
			stripePlanRefreshedAt,
			nextLadder,
			stripePlanRefreshedAt,
		],
		orgWhereSuffix: ' AND stripe_customer_id = ?',
		orgWhereValues: [input.customerId],
	})
	waitUntil(
		maybeSyncDiscordGuildRolesForUser({
			env: input.env,
			userId: input.userId,
			stripePlan: resolved.stripePlan,
		}),
	)
	const orgId = previous.org_id
	if (orgId) {
		const previousPlan = parseStripePlanName(previous.stripe_plan)
		const nextPlan = resolved.stripePlan
		if (
			(nextPlan === 'standard' || nextPlan === 'pro') &&
			nextPlan !== previousPlan
		) {
			waitUntil(
				sendToOrgBillingRecipients({
					db: input.env.APP_DB,
					orgId,
					sendOne: async (recipient) => {
						await sendBillingSuccessEmail({
							env: input.env,
							email: recipient.email,
							userId: recipient.userId,
							orgSlug: await readSignupOrgSlug(input.env.APP_DB, orgId),
							planLabel: nextPlan === 'pro' ? 'Pro' : 'Standard',
						})
					},
				}).catch((error) => {
					console.warn('billing-success-email-failed', error)
				}),
			)
		}
		const status = resolved.subscriptionStatus
		if (status === 'past_due' || status === 'unpaid') {
			const day = utcDayKey(now)
			waitUntil(
				sendToOrgBillingRecipients({
					db: input.env.APP_DB,
					orgId,
					sendOne: async (recipient) => {
						await sendPastDueEmail({
							env: input.env,
							email: recipient.email,
							userId: recipient.userId,
							orgSlug: await readSignupOrgSlug(input.env.APP_DB, orgId),
							day,
						})
					},
				}).catch((error) => {
					console.warn('billing-past-due-email-failed', error)
				}),
			)
		}
	}
	if (previous?.email) {
		scheduleKitSubscriberSync({
			env: input.env,
			email: previous.email,
			stableUserId: previous.stable_user_id,
		})
	}
	return resolved
}

async function loadBillingUserById(
	env: SyncEnv,
	userId: number,
): Promise<BillingUser | null> {
	const row = await env.APP_DB.prepare(
		`SELECT id, email, stable_user_id, personal_org_id
		 FROM users WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(userId)
		.first<{
			id: number
			email: string
			stable_user_id: OwnerId
			personal_org_id: string | null
		}>()
	if (!row) return null
	const personalOrgId = (row.personal_org_id?.trim() ||
		row.stable_user_id) as OwnerId
	return {
		id: row.id,
		email: row.email,
		stableUserId: row.stable_user_id,
		personalOrgId,
	}
}

/**
 * Resolve the Kody user that owns a Checkout Session by verifying
 * `client_reference_id` against `createBillingLinkReference`. Candidate users
 * are found via stable-user-id hint (session metadata), Stripe customer id, or
 * customer email — never by reversing the HMAC.
 */
export async function resolveBillingUserForCheckoutLink(input: {
	env: SyncEnv
	clientReferenceId: string | null | undefined
	stableUserIdHint?: string | null
	metadata?: Record<string, string> | null
	customerId?: string | null
	customerEmail?: string | null
}): Promise<BillingUser | null> {
	const clientReferenceId = input.clientReferenceId?.trim()
	if (!clientReferenceId) return null

	const candidates: Array<BillingUser> = []
	const seenIds = new Set<number>()

	async function pushCandidate(user: BillingUser | null) {
		if (!user || seenIds.has(user.id)) return
		seenIds.add(user.id)
		candidates.push(user)
	}

	const stableUserIdHint =
		resolveOrgIdFromStripeMetadata(input.metadata) ??
		input.stableUserIdHint?.trim() ??
		null
	if (stableUserIdHint) {
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id, personal_org_id FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)${andLiveDeletedAtSql()}`,
		)
			.bind(stableUserIdHint, stableUserIdHint)
			.first<{
				id: number
				email: string
				stable_user_id: OwnerId
				personal_org_id: string | null
			}>()
		await pushCandidate(
			row
				? {
						id: row.id,
						email: row.email,
						stableUserId: row.stable_user_id,
						personalOrgId: (row.personal_org_id?.trim() ||
							row.stable_user_id) as OwnerId,
					}
				: null,
		)
	}

	const customerId = input.customerId?.trim()
	if (customerId) {
		const orgRow = await input.env.APP_DB.prepare(
			`SELECT o.id AS org_id, u.id, u.email, u.stable_user_id
			 FROM orgs o
			 INNER JOIN users u ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
			 WHERE o.stripe_customer_id = ?
			   AND o.deleted_at IS NULL${andLiveDeletedAtSql('u')}`,
		)
			.bind(customerId)
			.first<{
				org_id: string
				id: number
				email: string
				stable_user_id: OwnerId
			}>()
		await pushCandidate(
			orgRow
				? {
						id: orgRow.id,
						email: orgRow.email,
						stableUserId: orgRow.stable_user_id,
						personalOrgId: orgRow.org_id as OwnerId,
					}
				: null,
		)
	}

	const customerEmail = input.customerEmail?.trim()
	if (customerEmail) {
		const normalized = normalizeEmail(customerEmail)
		const row = await input.env.APP_DB.prepare(
			`SELECT id, email, stable_user_id, personal_org_id
			 FROM users WHERE lower(email) = ?${andLiveDeletedAtSql()}`,
		)
			.bind(normalized)
			.first<{
				id: number
				email: string
				stable_user_id: OwnerId
				personal_org_id: string | null
			}>()
		await pushCandidate(
			row
				? {
						id: row.id,
						email: row.email,
						stableUserId: row.stable_user_id,
						personalOrgId: (row.personal_org_id?.trim() ||
							row.stable_user_id) as OwnerId,
					}
				: null,
		)
	}

	for (const candidate of candidates) {
		const expected = await createBillingLinkReference(
			input.env,
			candidate.personalOrgId,
		)
		if (expected === clientReferenceId) {
			return candidate
		}
	}
	return null
}

export async function findUserIdByStripeCustomerId(input: {
	env: SyncEnv
	customerId: string
}): Promise<number | null> {
	const customerId = input.customerId.trim()
	if (!customerId) return null
	const orgRow = await input.env.APP_DB.prepare(
		`SELECT u.id
		 FROM orgs o
		 INNER JOIN users u ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
		 WHERE o.stripe_customer_id = ?
		   AND o.deleted_at IS NULL${andLiveDeletedAtSql('u')}`,
	)
		.bind(customerId)
		.first<{ id: number }>()
	return orgRow?.id ?? null
}

/** Resolve the org that owns a Stripe customer (team or personal). */
function trimmedOwnerId(ownerId: OwnerId): OwnerId | null {
	const trimmed = ownerId.trim()
	if (!trimmed) return null
	return trimmed === ownerId ? ownerId : (trimmed as OwnerId)
}

export async function findOrgIdByStripeCustomerId(input: {
	env: SyncEnv
	customerId: string
}): Promise<OwnerId | null> {
	const customerId = input.customerId.trim()
	if (!customerId) return null
	const orgRow = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs WHERE stripe_customer_id = ? AND deleted_at IS NULL`,
	)
		.bind(customerId)
		.first<{ id: OwnerId }>()
	return orgRow?.id ? trimmedOwnerId(orgRow.id) : null
}

/**
 * Resolve the org id that owns a Checkout Session by verifying
 * `client_reference_id` against `createBillingLinkReference(orgId)`. Prefer
 * Stripe metadata (`kody_org_id`); never reverse the HMAC. Customer email is
 * a personal-org-only fallback (never used to resolve a team org).
 */
export async function resolveOrgIdForCheckoutLink(input: {
	env: SyncEnv
	clientReferenceId: string | null | undefined
	stableUserIdHint?: string | null
	metadata?: Record<string, string> | null
	customerId?: string | null
	customerEmail?: string | null
}): Promise<OwnerId | null> {
	const clientReferenceId = input.clientReferenceId?.trim()
	if (!clientReferenceId) return null

	const candidates: Array<OwnerId> = []
	const seen = new Set<string>()
	function pushCandidate(orgId: OwnerId | null | undefined) {
		const trimmed = orgId ? trimmedOwnerId(orgId) : null
		if (!trimmed || seen.has(trimmed)) return
		seen.add(trimmed)
		candidates.push(trimmed)
	}

	const stableUserIdHint = input.stableUserIdHint?.trim()
	pushCandidate(
		resolveOrgIdFromStripeMetadata(input.metadata) ??
			(stableUserIdHint ? (stableUserIdHint as OwnerId) : null),
	)

	const customerId = input.customerId?.trim()
	if (customerId) {
		pushCandidate(
			await findOrgIdByStripeCustomerId({ env: input.env, customerId }),
		)
	}

	const customerEmail = input.customerEmail?.trim()
	if (customerEmail) {
		const row = await input.env.APP_DB.prepare(
			`SELECT COALESCE(NULLIF(TRIM(personal_org_id), ''), stable_user_id) AS org_id
			 FROM users WHERE lower(email) = ?${andLiveDeletedAtSql()}`,
		)
			.bind(normalizeEmail(customerEmail))
			.first<{ org_id: OwnerId }>()
		// Personal org id from the account email. Never treat email as a
		// team-org resolver.
		pushCandidate(row?.org_id)
	}

	for (const orgId of candidates) {
		const expected = await createBillingLinkReference(input.env, orgId)
		if (expected !== clientReferenceId) continue
		const org = await input.env.APP_DB.prepare(
			`SELECT id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(orgId)
			.first<{ id: OwnerId }>()
		if (org?.id) return org.id
		// Personal org before/without an orgs row, or hint was the person id.
		const user = await input.env.APP_DB.prepare(
			`SELECT COALESCE(NULLIF(TRIM(personal_org_id), ''), stable_user_id) AS org_id
			 FROM users
			 WHERE (stable_user_id = ? OR personal_org_id = ?)
			   ${andLiveDeletedAtSql()}`,
		)
			.bind(orgId, orgId)
			.first<{ org_id: OwnerId }>()
		if (user?.org_id) return user.org_id
	}
	return null
}

async function loadCheckoutSessionForLink(input: {
	env: SyncEnv
	sessionId: string
}) {
	if (!isBillingConfigured(input.env)) {
		throw new BillingLinkError(
			'billing_not_configured',
			'Stripe billing is not configured on this deployment.',
		)
	}
	const sessionId = input.sessionId.trim()
	if (!sessionId) {
		throw new BillingLinkError(
			'missing_session',
			'Checkout session id is missing.',
		)
	}
	try {
		return await getCheckoutSession(input.env, sessionId)
	} catch (error) {
		if (error instanceof BillingNotConfiguredError) {
			throw new BillingLinkError(
				'billing_not_configured',
				'Stripe billing is not configured on this deployment.',
				{ cause: error },
			)
		}
		throw new BillingLinkError(
			'stripe_error',
			'Unable to verify the Stripe checkout session.',
			{ cause: error },
		)
	}
}

async function refreshAfterCheckoutLink(input: {
	env: SyncEnv
	orgId: OwnerId
	customerId: string
	now: Date
}): Promise<ResolvedSubscriptionPlan> {
	const backstopScheduled = await scheduleStripePlanRefreshBackstop({
		env: input.env,
		userId: input.orgId,
		now: input.now,
	})
	try {
		return await refreshStripePlanForOrg({
			env: input.env,
			orgId: input.orgId,
			customerId: input.customerId,
			now: input.now,
		})
	} catch (error) {
		if (
			error instanceof StripeApiError ||
			error instanceof BillingNotConfiguredError
		) {
			if (!backstopScheduled) throw error
			console.error('billing_link_refresh_failed', {
				orgId: input.orgId,
				error: error instanceof Error ? error.message : String(error),
			})
			return {
				stripePlan: null,
				creditsEligible: false,
				stripeInterval: null,
				stripePriceId: null,
				cancelAt: null,
				subscriptionStatus: null,
			}
		}
		throw error
	}
}

/**
 * Link a completed Checkout Session's Stripe customer onto the org row
 * identified by `orgId`. `client_reference_id` must be the org-backed HMAC.
 * The customer is stored on `orgs` only — never on a member `users` row.
 */
export async function linkStripeCustomerFromCheckoutSessionForOrg(input: {
	env: SyncEnv
	orgId: OwnerId
	sessionId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	const orgId = trimmedOwnerId(input.orgId)
	if (!orgId) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody organization matched this checkout session attribution.',
		)
	}

	const session = await loadCheckoutSessionForLink({
		env: input.env,
		sessionId: input.sessionId,
	})

	const expectedReference = await createBillingLinkReference(input.env, orgId)
	if (session.client_reference_id !== expectedReference) {
		throw new BillingLinkError(
			'client_reference_mismatch',
			'This checkout session does not belong to this organization.',
		)
	}

	const customerId = session.customer?.trim()
	if (!customerId) {
		throw new BillingLinkError(
			'missing_customer',
			'The checkout session did not include a Stripe customer.',
		)
	}

	const orgRow = await input.env.APP_DB.prepare(
		`SELECT id, stripe_customer_id FROM orgs WHERE id = ? AND deleted_at IS NULL`,
	)
		.bind(orgId)
		.first<{ id: string; stripe_customer_id: string | null }>()

	if (!orgRow) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody organization matched this checkout session attribution.',
		)
	}

	const claimedByOtherOrg = await input.env.APP_DB.prepare(
		`SELECT id FROM orgs
		 WHERE stripe_customer_id = ?
		   AND id != ?
		   AND deleted_at IS NULL`,
	)
		.bind(customerId, orgId)
		.first<{ id: string }>()
	if (claimedByOtherOrg) {
		throw new BillingLinkError(
			'customer_already_linked',
			'This Stripe customer is already linked to another Kody organization.',
		)
	}

	const existingCustomerId = orgRow.stripe_customer_id?.trim() || null
	if (existingCustomerId && existingCustomerId !== customerId) {
		throw new BillingLinkError(
			'account_already_linked',
			'This organization is already linked to a different Stripe customer. Contact the operator to relink it.',
		)
	}

	const now = input.now ?? new Date()
	const updatedAt = now.toISOString()
	// The claim is the person's, not the Stripe customer's: finalize it before
	// the customer link so a link failure cannot drop a completed discount.
	await recordPromoClaimFromCheckoutSession({
		db: input.env.APP_DB,
		orgId,
		session,
		now,
	})

	try {
		await updateOrgBillingColumns({
			db: input.env.APP_DB,
			orgId,
			setClause: 'stripe_customer_id = ?, updated_at = ?',
			values: [customerId, updatedAt],
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			throw new BillingLinkError(
				'customer_already_linked',
				'This Stripe customer is already linked to another Kody account.',
				{ cause: error },
			)
		}
		throw error
	}

	// ADR 0065: Customers created by Checkout start without org metadata.
	// Stamp after link so Stripe objects match the session/subscription keys.
	// Best-effort: a metadata failure must not undo the D1 customer link.
	try {
		await mergeStripeObjectMetadata(input.env, {
			object: 'customers',
			id: customerId,
			metadata: {
				...buildOrgBillingMetadata(orgId),
				...(session.metadata?.kody_plan?.trim()
					? { kody_plan: session.metadata.kody_plan.trim() }
					: {}),
			},
		})
	} catch (error) {
		console.warn('billing_link_customer_metadata_failed', {
			orgId,
			customerId,
			error: error instanceof Error ? error.message : String(error),
		})
	}

	// Success redirect often races the webhook. Skip a second subscriptions
	// list only when this looks like that race (same customer, plan refreshed
	// moments ago) — not when a previously linked customer buys again.
	if (existingCustomerId === customerId) {
		const linked = await input.env.APP_DB.prepare(
			`SELECT stripe_plan, stripe_price_id, stripe_credits_eligible,
			        stripe_plan_refreshed_at
			 FROM orgs WHERE id = ? AND deleted_at IS NULL`,
		)
			.bind(orgId)
			.first<{
				stripe_plan: string | null
				stripe_price_id: string | null
				stripe_credits_eligible: number | null
				stripe_plan_refreshed_at: string | null
			}>()
		const refreshedAtMs = linked?.stripe_plan_refreshed_at
			? Date.parse(linked.stripe_plan_refreshed_at)
			: Number.NaN
		const freshlyRefreshed =
			Number.isFinite(refreshedAtMs) &&
			now.getTime() - refreshedAtMs >= 0 &&
			now.getTime() - refreshedAtMs <= checkoutLinkReplayFreshMs
		if (linked?.stripe_plan && freshlyRefreshed) {
			return {
				stripePlan: parseStripePlanName(linked.stripe_plan),
				creditsEligible: linked.stripe_credits_eligible === 1,
				stripeInterval: null,
				stripePriceId: linked.stripe_price_id,
				cancelAt: null,
				subscriptionStatus: null,
			}
		}
	}

	return await refreshAfterCheckoutLink({
		env: input.env,
		orgId,
		customerId,
		now,
	})
}

/**
 * Personal-org convenience wrapper: links Stripe to the person's personal org.
 */
export async function linkStripeCustomerFromCheckoutSession(input: {
	env: SyncEnv
	user: BillingUser
	sessionId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	return linkStripeCustomerFromCheckoutSessionForOrg({
		env: input.env,
		orgId: input.user.personalOrgId,
		sessionId: input.sessionId,
		now: input.now,
	})
}

/**
 * Shared checkout-link path used by the success redirect and the
 * `checkout.session.completed` webhook. The link target is always an org;
 * the signed-in member is only the authorizing actor on the success path.
 */
export async function linkStripeCustomerFromCheckoutSessionAttribution(input: {
	env: SyncEnv
	sessionId: string
	clientReferenceId?: string | null
	stableUserIdHint?: string | null
	metadata?: Record<string, string> | null
	customerId?: string | null
	customerEmail?: string | null
	/** Prefer this: request-bound org id from the success redirect. */
	orgId?: OwnerId
	/**
	 * Legacy personal success path: treated as org id = stable user id.
	 * Prefer `orgId`.
	 */
	user?: BillingUser
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	const checkoutOrgId = input.orgId
	const trimmedCheckoutOrgId = checkoutOrgId?.trim()
	if (checkoutOrgId && trimmedCheckoutOrgId) {
		return linkStripeCustomerFromCheckoutSessionForOrg({
			env: input.env,
			orgId:
				trimmedCheckoutOrgId === checkoutOrgId
					? checkoutOrgId
					: (trimmedCheckoutOrgId as OwnerId),
			sessionId: input.sessionId,
			now: input.now,
		})
	}
	if (input.user) {
		return linkStripeCustomerFromCheckoutSessionForOrg({
			env: input.env,
			orgId: input.user.personalOrgId,
			sessionId: input.sessionId,
			now: input.now,
		})
	}

	let clientReferenceId = input.clientReferenceId
	let metadata = input.metadata
	let customerId = input.customerId
	if (clientReferenceId == null || metadata == null || customerId == null) {
		const session = await loadCheckoutSessionForLink({
			env: input.env,
			sessionId: input.sessionId,
		})
		clientReferenceId = clientReferenceId ?? session.client_reference_id
		metadata = metadata ?? session.metadata ?? null
		customerId = customerId ?? session.customer
	}

	const orgId = await resolveOrgIdForCheckoutLink({
		env: input.env,
		clientReferenceId,
		stableUserIdHint: input.stableUserIdHint,
		metadata,
		customerId,
		customerEmail: input.customerEmail,
	})
	if (!orgId) {
		throw new BillingLinkError(
			'user_not_found',
			'No Kody organization matched this checkout session attribution.',
		)
	}
	return linkStripeCustomerFromCheckoutSessionForOrg({
		env: input.env,
		orgId,
		sessionId: input.sessionId,
		now: input.now,
	})
}

/**
 * Refresh stripe_plan columns for an org. Personal orgs (a live users row
 * whose stable id is the org id) also sync Discord roles for that person.
 * Both paths write `orgs` only.
 */
export async function refreshStripePlanForOrg(input: {
	env: SyncEnv
	orgId: OwnerId
	customerId: string
	now?: Date
}): Promise<ResolvedSubscriptionPlan> {
	const orgId = input.orgId.trim()
	const personalUser = await input.env.APP_DB.prepare(
		`SELECT u.id AS id, o.stripe_customer_id AS stripe_customer_id
		 FROM users u
		 INNER JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
		 WHERE (u.stable_user_id = ? OR u.personal_org_id = ?)
		   ${andLiveDeletedAtSql('u')}${andLiveDeletedAtSql('o')}`,
	)
		.bind(orgId, orgId)
		.first<{ id: number; stripe_customer_id: string | null }>()
	if (personalUser?.id != null) {
		// Match the team-org guard: do not forgive/refresh against a foreign
		// or unlinked Stripe customer while the org UPDATE would no-op.
		if (personalUser.stripe_customer_id !== input.customerId) {
			throw new Error(
				personalUser.stripe_customer_id == null
					? `Cannot refresh Stripe plan: org ${orgId} has no Stripe customer linked yet.`
					: `Cannot refresh Stripe plan: Stripe customer mismatch for org ${orgId}.`,
			)
		}
		return refreshStripePlanForUser({
			env: input.env,
			userId: personalUser.id,
			customerId: input.customerId,
			now: input.now,
		})
	}

	const now = input.now ?? new Date()
	const previous = await input.env.APP_DB.prepare(
		`SELECT stripe_customer_id, stripe_price_id, ${userEntitlementColumnsSql()}
		 FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(orgId)
		.first<
			UserEntitlementRow & {
				stripe_customer_id: string | null
				stripe_price_id: string | null
			}
		>()
	if (!previous) {
		throw new Error(`Cannot refresh Stripe plan: missing org ${orgId}.`)
	}
	// Checkout link writes stripe_customer_id before refresh. Require that
	// link here so forgive/email cannot run against an unlinked or foreign
	// customer while the guarded UPDATE matches zero rows.
	if (previous.stripe_customer_id !== input.customerId) {
		throw new Error(
			previous.stripe_customer_id == null
				? `Cannot refresh Stripe plan: org ${orgId} has no Stripe customer linked yet.`
				: `Cannot refresh Stripe plan: Stripe customer mismatch for org ${orgId}.`,
		)
	}
	const subscriptions = await listSubscriptions(input.env, input.customerId)
	const resolved = resolveSubscriptionPlan(subscriptions, input.env)
	const nextLadder = resolveEntitlementLadderAfterPaidAccessChange({
		currentLadder: parseEntitlementLadder(previous.entitlement_ladder),
		manualPlan: parseStoredPlanName(previous.plan),
		previousStripePlan: parseStripePlanName(previous.stripe_plan),
		nextStripePlan: resolved.stripePlan,
		previousStripePriceId: previous.stripe_price_id,
		nextStripePriceId: resolved.stripePriceId,
	})
	await forgiveCreditUsageBeforeUnlock({
		db: input.env.APP_DB,
		userId: orgId,
		current: previous,
		next: {
			...previous,
			stripe_plan: resolved.stripePlan,
			stripe_credits_eligible: resolved.creditsEligible ? 1 : 0,
			entitlement_ladder: nextLadder,
		},
		now,
	})
	const stripePlanRefreshedAt = now.toISOString()
	const stripeCreditsEligible = resolved.creditsEligible ? 1 : 0
	await updateOrgBillingColumns({
		db: input.env.APP_DB,
		orgId,
		setClause: `stripe_plan = ?, stripe_price_id = ?, stripe_credits_eligible = ?,
		     stripe_plan_refreshed_at = ?, entitlement_ladder = ?, updated_at = ?`,
		values: [
			resolved.stripePlan,
			resolved.stripePriceId,
			stripeCreditsEligible,
			stripePlanRefreshedAt,
			nextLadder,
			stripePlanRefreshedAt,
		],
		orgWhereSuffix: ' AND stripe_customer_id = ?',
		orgWhereValues: [input.customerId],
	})

	const previousPlan = parseStripePlanName(previous.stripe_plan)
	const nextPlan = resolved.stripePlan
	if (
		(nextPlan === 'standard' || nextPlan === 'pro') &&
		nextPlan !== previousPlan
	) {
		waitUntil(
			sendToOrgBillingRecipients({
				db: input.env.APP_DB,
				orgId,
				sendOne: async (recipient) => {
					await sendBillingSuccessEmail({
						env: input.env,
						email: recipient.email,
						userId: recipient.userId,
						orgSlug: await readSignupOrgSlug(input.env.APP_DB, orgId),
						planLabel: nextPlan === 'pro' ? 'Pro' : 'Standard',
					})
				},
			}).catch((error) => {
				console.warn('billing-success-email-failed', error)
			}),
		)
	}
	const status = resolved.subscriptionStatus
	if (status === 'past_due' || status === 'unpaid') {
		const day = utcDayKey(now)
		waitUntil(
			sendToOrgBillingRecipients({
				db: input.env.APP_DB,
				orgId,
				sendOne: async (recipient) => {
					await sendPastDueEmail({
						env: input.env,
						email: recipient.email,
						userId: recipient.userId,
						orgSlug: await readSignupOrgSlug(input.env.APP_DB, orgId),
						day,
					})
				},
			}).catch((error) => {
				console.warn('billing-past-due-email-failed', error)
			}),
		)
	}
	return resolved
}

export async function refreshStripePlanForStripeCustomer(input: {
	env: SyncEnv
	customerId: string
	now?: Date
}): Promise<{
	userId: number | null
	orgId: OwnerId | null
	resolved: ResolvedSubscriptionPlan | null
}> {
	const userId = await findUserIdByStripeCustomerId({
		env: input.env,
		customerId: input.customerId,
	})
	if (userId != null) {
		const user = await loadBillingUserById(input.env, userId)
		if (!user) {
			return { userId: null, orgId: null, resolved: null }
		}
		await scheduleStripePlanRefreshBackstop({
			env: input.env,
			userId: user.personalOrgId,
			now: input.now,
		})
		const resolved = await refreshStripePlanForUser({
			env: input.env,
			userId: user.id,
			customerId: input.customerId,
			now: input.now,
		})
		return { userId: user.id, orgId: user.personalOrgId, resolved }
	}

	const orgId = await findOrgIdByStripeCustomerId({
		env: input.env,
		customerId: input.customerId,
	})
	if (!orgId) {
		return { userId: null, orgId: null, resolved: null }
	}
	await scheduleStripePlanRefreshBackstop({
		env: input.env,
		userId: orgId,
		now: input.now,
	})
	const resolved = await refreshStripePlanForOrg({
		env: input.env,
		orgId,
		customerId: input.customerId,
		now: input.now,
	})
	return { userId: null, orgId, resolved }
}

export function parseStoredStripePlan(value: string | null | undefined) {
	return parseStripePlanName(value)
}

export type { PlanName, ResolvedSubscriptionPlan }
