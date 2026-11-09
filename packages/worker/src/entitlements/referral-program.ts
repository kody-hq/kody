/**
 * Referral attribution at signup and invoice-gated Standard credit.
 * Reward is one stacked month for both parties; there is no annual or
 * lifetime cap on how many a referrer can earn.
 */

import { utcSqliteTimestamp } from '@kody-internal/shared/date-keys.ts'
import { computeOverageInvoiceMetadataKey } from '#worker/billing/stripe-client.ts'
import {
	isReferralStandardCreditActive,
	laterIsoTimestamp,
	normalizeEmailForReferralFraud,
	normalizeReferralCode,
	parseReferrerInput,
	lateReferralWindowMs,
	referralSharePath,
	referralStandardCreditDurationMs,
	unixSecondsToIso,
	type ReferralProgramListItem,
	type ReferralProgramSummary,
	type ReferralRejectReason,
	type ReferredByState,
} from '#universal/referral-program.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export type ReferralAttributionOutcome =
	| { outcome: 'attributed' }
	| { outcome: 'ignored'; reason: 'missing_code' | 'unknown_referrer' | 'self' }
	| { outcome: 'already_attributed' }

export type LateReferralAttributionOutcome =
	| { outcome: 'attributed'; referrerUsername: string }
	| {
			outcome: 'rejected'
			reason:
				| 'invalid_code'
				| 'unknown_referrer'
				| 'self'
				| 'already_attributed'
				| 'already_paid'
				| 'window_closed'
	  }

export type ReferralRewardOutcome =
	| { outcome: 'rewarded' }
	| { outcome: 'held_unverified' }
	| { outcome: 'already_rewarded' }
	| { outcome: 'rejected'; reason: ReferralRejectReason }
	| { outcome: 'ignored'; reason: 'no_pending' | 'invoice_unqualified' }

type ReferralParty = {
	stable_user_id: string
	org_id: string
	username: string
	email: string
	email_verified_at: string | null
	stripe_customer_id: string | null
	referral_standard_credit_expires_at: string | null
}

type PendingReferralRow = {
	id: number
	referrer_stable_user_id: string
	referee_stable_user_id: string
	status: string
	reward_invoice_id: string | null
	held_invoice_id: string | null
	held_period_end_at: string | null
	credits_granted_at: string | null
}

export function isQualifyingPaidReferralInvoice(invoice: {
	status?: unknown
	paid?: unknown
	amount_paid?: unknown
	billing_reason?: unknown
	subscription?: unknown
	metadata?: Record<string, string> | null
}): boolean {
	const amountPaid =
		typeof invoice.amount_paid === 'number' ? invoice.amount_paid : Number.NaN
	if (!Number.isFinite(amountPaid) || amountPaid <= 0) return false
	const status = typeof invoice.status === 'string' ? invoice.status.trim() : ''
	const paid = invoice.paid === true || status === 'paid'
	if (!paid) return false
	if (invoice.metadata?.[computeOverageInvoiceMetadataKey] === '1') {
		return false
	}
	const reason =
		typeof invoice.billing_reason === 'string'
			? invoice.billing_reason.trim()
			: ''
	const hasSubscription =
		typeof invoice.subscription === 'string' &&
		invoice.subscription.trim().length > 0
	if (reason === 'manual' && !hasSubscription) return false
	if (reason === 'upcoming') return false
	return true
}

export function readStripeInvoiceCustomerId(
	object: Record<string, unknown>,
): string | null {
	const customer = object.customer
	if (typeof customer === 'string' && customer.trim()) return customer.trim()
	if (customer && typeof customer === 'object' && 'id' in customer) {
		const id = (customer as { id?: unknown }).id
		if (typeof id === 'string' && id.trim()) return id.trim()
	}
	return null
}

export function readStripeInvoiceId(
	object: Record<string, unknown>,
): string | null {
	const id = object.id
	return typeof id === 'string' && id.trim() ? id.trim() : null
}

export function readStripeInvoicePeriodEndIso(
	object: Record<string, unknown>,
): string | null {
	const lines = object.lines
	const ends: Array<string> = []
	if (lines && typeof lines === 'object' && 'data' in lines) {
		const data = (lines as { data?: unknown }).data
		if (Array.isArray(data)) {
			for (const line of data) {
				if (!line || typeof line !== 'object') continue
				const period = (line as { period?: { end?: unknown } }).period
				const iso = unixSecondsToIso(period?.end)
				if (iso) ends.push(iso)
			}
		}
	}
	return laterIsoTimestamp(...ends)
}

export function readStripeInvoiceSubscriptionId(
	object: Record<string, unknown>,
): string | null {
	const top = object.subscription
	if (typeof top === 'string' && top.trim()) return top.trim()
	const parent = object.parent
	if (parent && typeof parent === 'object') {
		const details = (
			parent as { subscription_details?: { subscription?: unknown } }
		).subscription_details
		const nested = details?.subscription
		if (typeof nested === 'string' && nested.trim()) return nested.trim()
	}
	return null
}

export async function attributeReferralAtSignup(input: {
	db: D1Database
	refereeStableUserId: string
	refereeUsername: string
	referralCode: string | null | undefined
	now?: Date
}): Promise<ReferralAttributionOutcome> {
	if (typeof input.db.prepare !== 'function') {
		return { outcome: 'ignored', reason: 'missing_code' }
	}
	const code = normalizeReferralCode(input.referralCode)
	if (!code) return { outcome: 'ignored', reason: 'missing_code' }
	if (code === normalizeReferralCode(input.refereeUsername)) {
		return { outcome: 'ignored', reason: 'self' }
	}
	const referrer = await input.db
		.prepare(
			`SELECT stable_user_id
			 FROM users
			 WHERE username = ?${andLiveDeletedAtSql()}`,
		)
		.bind(code)
		.first<{ stable_user_id: string }>()
	if (!referrer?.stable_user_id) {
		return { outcome: 'ignored', reason: 'unknown_referrer' }
	}
	if (referrer.stable_user_id === input.refereeStableUserId) {
		return { outcome: 'ignored', reason: 'self' }
	}
	const now = input.now ?? new Date()
	try {
		await input.db
			.prepare(
				`INSERT INTO referrals (
					referrer_stable_user_id, referee_stable_user_id, created_at, status
				) VALUES (?, ?, ?, 'pending')`,
			)
			.bind(
				referrer.stable_user_id,
				input.refereeStableUserId,
				now.toISOString(),
			)
			.run()
		return { outcome: 'attributed' }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			return { outcome: 'already_attributed' }
		}
		throw error
	}
}

/**
 * Orgs whose payments count as this person's: their personal org (by id or
 * `personal_org_id`) and every live org they own or bill. Binds the person's
 * stable id three times.
 */
const personPaymentOrgsSql = `SELECT o.id, o.stripe_customer_id, o.referral_first_paid_at
	FROM orgs o
	WHERE o.deleted_at IS NULL
	  AND (
		o.id = ?
		OR o.id IN (
			SELECT NULLIF(TRIM(u.personal_org_id), '')
			FROM users u
			WHERE u.stable_user_id = ? AND u.deleted_at IS NULL
		)
		OR o.id IN (
			SELECT m.org_id
			FROM org_memberships m
			WHERE m.user_id = ?
			  AND m.role IN ('owner', 'billing')
			  AND m.deleted_at IS NULL
		)
	  )`

/** Stripe lookup for a customer's paid invoices (injected for tests). */
export type ListCustomerPaidInvoices = (
	customerId: string,
) => Promise<{ invoices: Array<Record<string, unknown>>; hasMore: boolean }>

/**
 * True when any org this person owns or bills has a qualifying paid Kody
 * invoice: the write-once `referral_first_paid_at` marker, or Stripe history
 * (covers invoices paid before the marker existed). A full page with no
 * qualifying invoice still counts as paid, so a lookup gap never opens entry.
 */
export async function personHasPaidKodyInvoice(input: {
	db: D1Database
	stableUserId: string
	listPaidInvoices: ListCustomerPaidInvoices
}): Promise<boolean> {
	const orgs = await input.db
		.prepare(personPaymentOrgsSql)
		.bind(input.stableUserId, input.stableUserId, input.stableUserId)
		.all<{
			id: string
			stripe_customer_id: string | null
			referral_first_paid_at: string | null
		}>()
	const rows = orgs.results ?? []
	if (rows.some((row) => row.referral_first_paid_at?.trim())) return true
	const customers = new Set(
		rows
			.map((row) => row.stripe_customer_id?.trim() ?? '')
			.filter((id) => id.length > 0),
	)
	for (const customerId of customers) {
		const page = await input.listPaidInvoices(customerId)
		const qualifying = page.invoices.some((invoice) =>
			isQualifyingPaidReferralInvoice({
				status: invoice.status,
				paid: invoice.paid,
				amount_paid: invoice.amount_paid,
				billing_reason: invoice.billing_reason,
				subscription: readStripeInvoiceSubscriptionId(invoice),
				metadata:
					invoice.metadata && typeof invoice.metadata === 'object'
						? (invoice.metadata as Record<string, string>)
						: null,
			}),
		)
		if (qualifying || page.hasMore) return true
	}
	return false
}

/**
 * Billing-page "Referred by" for an existing account. Write-once (unique
 * referee index), only within 72 hours of signup, and only before the
 * person's first paid Kody invoice. The
 * insert re-checks the paid marker in the same statement, and invoice.paid
 * stamps that marker before it looks for a pending referral, so an invoice
 * paid during this call either blocks the insert or rewards it.
 */
export async function attributeReferralBeforeFirstPayment(input: {
	db: D1Database
	refereeStableUserId: string
	referrerInput: unknown
	listPaidInvoices: ListCustomerPaidInvoices
	now?: Date
}): Promise<LateReferralAttributionOutcome> {
	const code = parseReferrerInput(input.referrerInput)
	if (!code) return { outcome: 'rejected', reason: 'invalid_code' }
	const referrer = await input.db
		.prepare(
			`SELECT stable_user_id, username
			 FROM users
			 WHERE username = ?${andLiveDeletedAtSql()}`,
		)
		.bind(code)
		.first<{ stable_user_id: string; username: string }>()
	if (!referrer?.stable_user_id) {
		return { outcome: 'rejected', reason: 'unknown_referrer' }
	}
	if (referrer.stable_user_id === input.refereeStableUserId) {
		return { outcome: 'rejected', reason: 'self' }
	}
	const [referrerParty, refereeParty] = await Promise.all([
		loadParty(input.db, referrer.stable_user_id),
		loadParty(input.db, input.refereeStableUserId),
	])
	if (
		referrerParty &&
		refereeParty &&
		rejectReasonForParties(referrerParty, refereeParty)
	) {
		return { outcome: 'rejected', reason: 'self' }
	}
	const existing = await input.db
		.prepare(
			`SELECT 1 AS found FROM referrals WHERE referee_stable_user_id = ?`,
		)
		.bind(input.refereeStableUserId)
		.first<{ found: number }>()
	if (existing) return { outcome: 'rejected', reason: 'already_attributed' }
	const now = input.now ?? new Date()
	if (
		!(await signedUpWithinLateReferralWindow(
			input.db,
			input.refereeStableUserId,
			now,
		))
	) {
		return { outcome: 'rejected', reason: 'window_closed' }
	}
	if (
		await personHasPaidKodyInvoice({
			db: input.db,
			stableUserId: input.refereeStableUserId,
			listPaidInvoices: input.listPaidInvoices,
		})
	) {
		return { outcome: 'rejected', reason: 'already_paid' }
	}
	try {
		const result = await input.db
			.prepare(
				`INSERT INTO referrals (
					referrer_stable_user_id, referee_stable_user_id, created_at, status
				)
				SELECT ?, ?, ?, 'pending'
				WHERE NOT EXISTS (
					SELECT 1 FROM (${personPaymentOrgsSql}) paid
					WHERE paid.referral_first_paid_at IS NOT NULL
				)`,
			)
			.bind(
				referrer.stable_user_id,
				input.refereeStableUserId,
				now.toISOString(),
				input.refereeStableUserId,
				input.refereeStableUserId,
				input.refereeStableUserId,
			)
			.run()
		if ((result.meta?.changes ?? 0) === 0) {
			return { outcome: 'rejected', reason: 'already_paid' }
		}
		return { outcome: 'attributed', referrerUsername: referrer.username }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE constraint failed/i.test(message)) {
			return { outcome: 'rejected', reason: 'already_attributed' }
		}
		throw error
	}
}

async function signedUpWithinLateReferralWindow(
	db: D1Database,
	stableUserId: string,
	now: Date,
) {
	const row = await db
		.prepare(
			`SELECT created_at FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(stableUserId)
		.first<{ created_at: string | null }>()
	const createdAt = row?.created_at?.trim()
	if (!createdAt) return false
	const createdMs = Date.parse(
		createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`,
	)
	if (!Number.isFinite(createdMs)) return false
	return now.getTime() < createdMs + lateReferralWindowMs
}

async function loadReferredByState(input: {
	db: D1Database
	stableUserId: string
	personHasPaid?: () => Promise<boolean>
	now: Date
}): Promise<ReferredByState> {
	const row = await input.db
		.prepare(
			`SELECT r.status, u.username AS referrer_username
			 FROM referrals r
			 LEFT JOIN users u
				ON u.stable_user_id = r.referrer_stable_user_id
				AND u.deleted_at IS NULL
			 WHERE r.referee_stable_user_id = ?`,
		)
		.bind(input.stableUserId)
		.first<{ status: string; referrer_username: string | null }>()
	if (row) {
		if (row.status !== 'pending' && row.status !== 'rewarded') {
			return { state: 'closed' }
		}
		return {
			state: 'attributed',
			referrerUsername: row.referrer_username,
			status: row.status,
		}
	}
	if (!input.personHasPaid) return { state: 'closed' }
	if (
		!(await signedUpWithinLateReferralWindow(
			input.db,
			input.stableUserId,
			input.now,
		))
	) {
		return { state: 'closed' }
	}
	try {
		return (await input.personHasPaid())
			? { state: 'closed' }
			: { state: 'open' }
	} catch (error) {
		console.error('referral_referred_by_state_failed', {
			message: error instanceof Error ? error.message : String(error),
		})
		return { state: 'closed' }
	}
}

async function loadParty(
	db: D1Database,
	stableUserId: string,
): Promise<ReferralParty | null> {
	return db
		.prepare(
			`SELECT u.stable_user_id,
			        COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) AS org_id,
			        u.username, u.email, u.email_verified_at,
			        o.stripe_customer_id,
			        o.referral_standard_credit_expires_at
			 FROM users u
			 LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)${andLiveDeletedAtSql('o')}
			 WHERE u.stable_user_id = ?${andLiveDeletedAtSql('u')}`,
		)
		.bind(stableUserId)
		.first<ReferralParty>()
}

function rejectReasonForParties(
	referrer: ReferralParty,
	referee: ReferralParty,
): ReferralRejectReason | null {
	if (referrer.stable_user_id === referee.stable_user_id) {
		return 'self_referral'
	}
	if (
		normalizeEmailForReferralFraud(referrer.email) ===
		normalizeEmailForReferralFraud(referee.email)
	) {
		return 'same_email'
	}
	const referrerCustomer = referrer.stripe_customer_id?.trim() || null
	const refereeCustomer = referee.stripe_customer_id?.trim() || null
	if (
		referrerCustomer &&
		refereeCustomer &&
		referrerCustomer === refereeCustomer
	) {
		return 'same_stripe_customer'
	}
	return null
}

async function markRejected(
	db: D1Database,
	referralId: number,
	reason: ReferralRejectReason,
) {
	await db
		.prepare(
			`UPDATE referrals
			 SET status = 'rejected', reject_reason = ?, rewarded_at = NULL
			 WHERE id = ? AND status = 'pending'`,
		)
		.bind(reason, referralId)
		.run()
}

function stackReferralCreditStatement(input: {
	db: D1Database
	orgId: string
	paidPeriodEndAt: string | null
	referralId: number
	invoiceId: string
	now: Date
}) {
	return input.db
		.prepare(
			`UPDATE orgs
			 SET referral_standard_credit_expires_at = strftime(
			       '%Y-%m-%dT%H:%M:%fZ',
			       max(
			         strftime('%s', ?),
			         COALESCE(strftime('%s', referral_standard_credit_expires_at), 0),
			         COALESCE(strftime('%s', ?), 0)
			       ) + ?,
			       'unixepoch'
			     ),
			     updated_at = ?
			 WHERE id = ?
			   AND deleted_at IS NULL
			   AND EXISTS (
			     SELECT 1 FROM referrals
			     WHERE id = ?
			       AND reward_invoice_id = ?
			       AND credits_granted_at IS NULL
			   )`,
		)
		.bind(
			input.now.toISOString(),
			input.paidPeriodEndAt ?? '1970-01-01T00:00:00.000Z',
			referralStandardCreditDurationMs / 1000,
			utcSqliteTimestamp(input.now),
			input.orgId,
			input.referralId,
			input.invoiceId,
		)
}

export async function rewardReferralForPaidInvoice(input: {
	db: D1Database
	refereeStableUserId: string
	invoiceId: string
	invoiceQualifies: boolean
	paidPeriodEndAt?: string | null
	referrerPaidPeriodEndAt?: string | null
	now?: Date
}): Promise<ReferralRewardOutcome> {
	if (typeof input.db.prepare !== 'function') {
		return { outcome: 'ignored', reason: 'no_pending' }
	}
	const now = input.now ?? new Date()
	const pending = await input.db
		.prepare(
			`SELECT id, referrer_stable_user_id, referee_stable_user_id, status,
			        reward_invoice_id, held_invoice_id, held_period_end_at,
			        credits_granted_at
			 FROM referrals
			 WHERE referee_stable_user_id = ?`,
		)
		.bind(input.refereeStableUserId)
		.first<PendingReferralRow>()
	if (!pending) return { outcome: 'ignored', reason: 'no_pending' }
	if (pending.status === 'rewarded' && pending.credits_granted_at) {
		return { outcome: 'already_rewarded' }
	}
	if (pending.status !== 'pending' && pending.status !== 'rewarded') {
		return { outcome: 'ignored', reason: 'no_pending' }
	}
	if (!input.invoiceQualifies) {
		return { outcome: 'ignored', reason: 'invoice_unqualified' }
	}

	const [referrer, referee] = await Promise.all([
		loadParty(input.db, pending.referrer_stable_user_id),
		loadParty(input.db, pending.referee_stable_user_id),
	])
	if (!referrer || !referee) return { outcome: 'ignored', reason: 'no_pending' }

	const reject = rejectReasonForParties(referrer, referee)
	if (reject) {
		await markRejected(input.db, pending.id, reject)
		return { outcome: 'rejected', reason: reject }
	}

	if (!referrer.email_verified_at || !referee.email_verified_at) {
		await input.db
			.prepare(
				`UPDATE referrals
				 SET held_invoice_id = COALESCE(held_invoice_id, ?),
				     held_period_end_at = COALESCE(held_period_end_at, ?)
				 WHERE id = ? AND status = 'pending'`,
			)
			.bind(input.invoiceId, input.paidPeriodEndAt ?? null, pending.id)
			.run()
		return { outcome: 'held_unverified' }
	}

	const rewardedAt = now.toISOString()
	const invoiceId =
		pending.status === 'rewarded'
			? (pending.reward_invoice_id ?? input.invoiceId)
			: input.invoiceId
	await input.db.batch([
		input.db
			.prepare(
				`UPDATE referrals
				 SET status = 'rewarded',
				     rewarded_at = COALESCE(rewarded_at, ?),
				     reward_invoice_id = COALESCE(reward_invoice_id, ?),
				     held_invoice_id = NULL,
				     held_period_end_at = NULL
				 WHERE id = ? AND (status = 'pending' OR credits_granted_at IS NULL)`,
			)
			.bind(rewardedAt, invoiceId, pending.id),
		stackReferralCreditStatement({
			db: input.db,
			orgId: referrer.org_id,
			paidPeriodEndAt: input.referrerPaidPeriodEndAt ?? null,
			referralId: pending.id,
			invoiceId,
			now,
		}),
		stackReferralCreditStatement({
			db: input.db,
			orgId: referee.org_id,
			paidPeriodEndAt: input.paidPeriodEndAt ?? null,
			referralId: pending.id,
			invoiceId,
			now,
		}),
		input.db
			.prepare(
				`UPDATE referrals
				 SET credits_granted_at = ?
				 WHERE id = ? AND credits_granted_at IS NULL`,
			)
			.bind(rewardedAt, pending.id),
	])
	const granted = await input.db
		.prepare(
			`SELECT credits_granted_at, reward_invoice_id
			 FROM referrals WHERE id = ?`,
		)
		.bind(pending.id)
		.first<{
			credits_granted_at: string | null
			reward_invoice_id: string | null
		}>()
	if (
		granted?.credits_granted_at &&
		granted.reward_invoice_id !== input.invoiceId
	) {
		return { outcome: 'already_rewarded' }
	}
	if (!granted?.credits_granted_at) {
		return { outcome: 'already_rewarded' }
	}
	return { outcome: 'rewarded' }
}

export async function maybeRewardHeldReferralAfterEmailVerified(input: {
	db: D1Database
	stableUserId: string
	referrerPaidPeriodEndAt?: string | null
	resolveReferrerPaidPeriodEnd?: (
		referrerStableUserId: string,
	) => Promise<string | null>
	now?: Date
}): Promise<ReferralRewardOutcome | { outcome: 'ignored'; reason: 'no_held' }> {
	if (typeof input.db.prepare !== 'function') {
		return { outcome: 'ignored', reason: 'no_held' }
	}
	const held = await input.db
		.prepare(
			`SELECT id, referrer_stable_user_id, referee_stable_user_id, status,
			        reward_invoice_id, held_invoice_id, held_period_end_at,
			        credits_granted_at
			 FROM referrals
			 WHERE (referee_stable_user_id = ? OR referrer_stable_user_id = ?)
			   AND status = 'pending'
			   AND held_invoice_id IS NOT NULL
			 ORDER BY created_at ASC`,
		)
		.bind(input.stableUserId, input.stableUserId)
		.all<PendingReferralRow>()
	const rows = held.results ?? []
	if (rows.length === 0) {
		return { outcome: 'ignored', reason: 'no_held' }
	}
	let last: ReferralRewardOutcome = { outcome: 'ignored', reason: 'no_pending' }
	for (const pending of rows) {
		if (!pending.held_invoice_id) continue
		let referrerPaidPeriodEndAt: string | null
		try {
			referrerPaidPeriodEndAt = input.resolveReferrerPaidPeriodEnd
				? await input.resolveReferrerPaidPeriodEnd(
						pending.referrer_stable_user_id,
					)
				: (input.referrerPaidPeriodEndAt ?? null)
		} catch (error) {
			console.warn('referral-held-referrer-period-end-failed', error)
			continue
		}
		last = await rewardReferralForPaidInvoice({
			db: input.db,
			refereeStableUserId: pending.referee_stable_user_id,
			invoiceId: pending.held_invoice_id,
			invoiceQualifies: true,
			paidPeriodEndAt: pending.held_period_end_at,
			referrerPaidPeriodEndAt,
			now: input.now,
		})
	}
	return last
}

export async function loadReferralProgramSummary(input: {
	db: D1Database
	stableUserId: string
	username: string
	origin: string
	/** Omit to hide the "Referred by" entry (state `closed` unless attributed). */
	personHasPaid?: () => Promise<boolean>
	now?: Date
}): Promise<ReferralProgramSummary> {
	const now = input.now ?? new Date()
	const creditRow = await input.db
		.prepare(
			`SELECT referral_standard_credit_expires_at
			 FROM orgs
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(input.stableUserId)
		.first<{ referral_standard_credit_expires_at: string | null }>()
	const creditExpiresAt =
		creditRow?.referral_standard_credit_expires_at?.trim() || null
	const [rows, counts, referredBy] = await Promise.all([
		input.db
			.prepare(
				`SELECT r.status, r.created_at, r.rewarded_at, u.username AS referee_username
				 FROM referrals r
				 LEFT JOIN users u
					ON u.stable_user_id = r.referee_stable_user_id
					AND u.deleted_at IS NULL
				 WHERE r.referrer_stable_user_id = ?
				   AND r.status IN ('pending', 'rewarded')
				 ORDER BY r.created_at DESC LIMIT 50`,
			)
			.bind(input.stableUserId)
			.all<{
				status: string
				created_at: string
				rewarded_at: string | null
				referee_username: string | null
			}>(),
		input.db
			.prepare(
				`SELECT status, COUNT(*) AS total
				 FROM referrals
				 WHERE referrer_stable_user_id = ?
				   AND status IN ('pending', 'rewarded')
				 GROUP BY status`,
			)
			.bind(input.stableUserId)
			.all<{ status: string; total: number }>(),
		loadReferredByState({
			db: input.db,
			stableUserId: input.stableUserId,
			personHasPaid: input.personHasPaid,
			now,
		}),
	])
	const referrals: Array<ReferralProgramListItem> = (rows.results ?? []).map(
		(row) => ({
			refereeUsername: row.referee_username,
			status: row.status === 'rewarded' ? 'rewarded' : 'pending',
			createdAt: row.created_at,
			rewardedAt: row.rewarded_at,
		}),
	)
	const countFor = (status: string) => {
		const total = counts.results?.find((row) => row.status === status)?.total
		const parsed = typeof total === 'number' ? total : Number(total)
		return Number.isFinite(parsed) ? parsed : 0
	}
	const sharePath = referralSharePath(input.username)
	return {
		sharePath,
		shareUrl: new URL(sharePath, input.origin).toString(),
		rewardedCount: countFor('rewarded'),
		pendingCount: countFor('pending'),
		creditExpiresAt,
		creditActive: isReferralStandardCreditActive(creditExpiresAt, now),
		referrals,
		referredBy,
	}
}

export function laterStandardOverlayExpiry(
	giftExpiresAt: string | null | undefined,
	referralExpiresAt: string | null | undefined,
): string | null {
	return laterIsoTimestamp(giftExpiresAt, referralExpiresAt)
}
