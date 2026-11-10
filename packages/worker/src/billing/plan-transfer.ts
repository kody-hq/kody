import {
	statesOf,
	finalStatesOf,
	parseState,
	sqlStatesOf,
	sqlSourcesOf,
} from '@kody-internal/shared/state-machine.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type {
	PlanTransferFreeLimit,
	PlanTransferOrgSummary,
	PlanTransferPreview,
} from '#universal/loader-data.ts'
import { parsePlanName, planLimits } from '#universal/plans.ts'
import {
	countLiveFreeOwnedOrgs,
	countLiveSeats,
	isPaidOrgBilling,
	MAX_FREE_ORGS_PER_USER,
} from '#worker/orgs/billing.ts'
import { logOrgAuditEvent } from '#worker/orgs/org-audit.ts'
import {
	createBillingLinkReference,
	getPriceIdForPlan,
	isBillingConfigured,
	isKodySubscription,
	selectPlanRetainingSubscriptions,
	type BillingInterval,
} from './billing-config.ts'
import { readCreditWallet } from './credit-wallet.ts'
import { buildOrgBillingMetadata } from './org-stripe-metadata.ts'
import {
	planTransferState,
	type PlanTransferStatus,
} from './plan-transfer-state.ts'
import { selectPurchasableSeatSubscription } from './seat-sync.ts'
import {
	cancelSubscription,
	createCheckoutSession,
	createCustomerBalanceCredit,
	createPlanTransferCreditNote,
	isPlanTransferCreditNote,
	listCreditNotesForInvoice,
	listCustomerBalanceTransactions,
	listPaidInvoicesForSubscription,
	listSubscriptions,
	planTransferMetadataKey,
	previewPlanTransferCreditNote,
	readStripeSubscriptionPeriodEndUnix,
	StripeApiError,
	StripeCreditNoteListIncompleteError,
	type CreditNoteLineInput,
	type StripeSubscription,
} from './stripe-client.ts'
import { refreshStripePlanForOrg } from './subscription-sync.ts'
import {
	computeMaxRefundMinor,
	computeProratedRefundMinor,
	selectRefundableInvoice,
} from './unused-subscription-value.ts'

/**
 * Moves a paid Pro subscription from one org to another org the same person
 * owns (ADR 0065 keeps every org its own billing boundary, so nothing is
 * pooled). The source subscription is canceled, its unused prepaid time is
 * recorded on the source invoice as an out-of-band credit note, and the same
 * value is credited to the target org's Stripe customer balance, which Stripe
 * applies to the target's next invoices. Only the plan moves: packages,
 * credentials, connections, memories, members, and prepaid usage credits stay
 * where they are.
 *
 * Every Stripe step is recorded on `org_plan_transfers` before the next one
 * runs, under a short lease, so a retry (button, page load, success redirect,
 * or webhook) resumes where the last attempt stopped. Issuing the credit note
 * is the point of no return: before it a transfer can be canceled, after it a
 * transfer can only be finished.
 */

export type { PlanTransferStatus } from './plan-transfer-state.ts'

export type PlanTransferRow = {
	id: string
	source_org_id: string
	target_org_id: string
	requested_by_user_id: string
	status: PlanTransferStatus
	target_interval: BillingInterval
	source_subscription_id: string
	source_invoice_id: string | null
	credit_amount_minor: number | null
	currency: string | null
	checkout_session_id: string | null
	checkout_expires_at: string | null
	source_canceled_at: string | null
	source_credit_note_id: string | null
	target_balance_transaction_id: string | null
	lease_expires_at: string | null
	last_error_code: string | null
	created_at: string
	updated_at: string
	completed_at: string | null
}

export type PlanTransferBlockReason =
	| 'billing_not_configured'
	| 'same_org'
	| 'not_owner_source'
	| 'not_owner_target'
	| 'source_unavailable'
	| 'target_unavailable'
	| 'source_manual_plan'
	| 'source_not_stripe_pro'
	| 'source_not_active'
	| 'source_canceling'
	| 'target_unsupported_subscription'
	| 'target_customer_shared'
	| 'currency_mismatch'
	| 'free_org_limit'
	| 'transfer_in_progress'
	| 'credit_unavailable'

const blockMessages: Record<PlanTransferBlockReason, string> = {
	billing_not_configured: 'Billing is not configured for this environment.',
	same_org: 'Pick a different organization to move the plan to.',
	not_owner_source:
		'Only an owner of this organization can move its plan. Billing admins can manage the plan but cannot move it.',
	not_owner_target:
		'You can only move a plan to an organization you own. Ask an owner of that organization to make you an owner first.',
	source_unavailable: 'This organization is unavailable.',
	target_unavailable: 'That organization is unavailable.',
	source_manual_plan:
		'This organization has a plan set by Kody support, so there is no paid subscription to move. Contact support to change it.',
	source_not_stripe_pro:
		'Only a current Pro subscription can be moved. Older or custom plans keep their billing as is; manage them in the billing portal.',
	source_not_active:
		'The subscription must be active and fully paid before it can move. Update your payment method in the billing portal and try again.',
	source_canceling:
		'This subscription is already set to cancel. Resume it in the billing portal before moving it.',
	target_unsupported_subscription:
		'That organization already has an older or custom subscription. Manage it in the billing portal before moving a plan into it.',
	target_customer_shared:
		'That organization is billed together with another product, so a credit there could be spent outside Kody. Contact support to move this plan.',
	currency_mismatch:
		'The two organizations are billed in different currencies, so the remaining value cannot be credited automatically. Contact support.',
	free_org_limit: `Moving the plan would leave an owner of this organization with more than ${MAX_FREE_ORGS_PER_USER} Free organizations. Make another organization paid or delete one first.`,
	transfer_in_progress:
		'A plan move is already in progress for one of these organizations. Finish or cancel it first.',
	credit_unavailable:
		'Stripe could not confirm the remaining value of this subscription. Nothing was changed. Try again in a few minutes.',
}

export function planTransferBlockMessage(reason: PlanTransferBlockReason) {
	return blockMessages[reason]
}

export type {
	PlanTransferFreeLimit,
	PlanTransferOrgSummary,
	PlanTransferPreview,
} from '#universal/loader-data.ts'

export type PlanTransferPreviewResult =
	| { ok: true; preview: PlanTransferPreview }
	| { ok: false; reason: PlanTransferBlockReason; message: string }

type PlanTransferEnv = Env

type OrgBillingRow = {
	id: string
	slug: string
	display_name: string | null
	plan: string
	stripe_plan: string | null
	stripe_customer_id: string | null
	deleting_at: string | null
	suspended_at: string | null
	personal: number
}

const proSeatPriceMinor: Record<BillingInterval, number> = {
	month: 1_200,
	year: 12_000,
}
const leaseMs = 2 * 60 * 1000
const checkoutLifetimeSeconds = 60 * 60
const checkoutExpiryGraceMs = 10 * 60 * 1000
const openStatuses = statesOf(planTransferState).filter(
	(status) =>
		!finalStatesOf(planTransferState).includes(
			parseState(planTransferState, status),
		),
)
const openStatusSql = sqlStatesOf(planTransferState, openStatuses)
const cancelOpenGuard = sqlSourcesOf(planTransferState, 'CANCEL', openStatuses)
const cancelUnleasedGuard = sqlSourcesOf(planTransferState, 'CANCEL', [
	'pending_checkout',
	'needs_retry',
])
const cancelExpiredLeaseGuard = sqlSourcesOf(planTransferState, 'CANCEL', [
	'applying',
])
const claimLeaseGuard = sqlSourcesOf(planTransferState, 'CLAIM_LEASE', [
	'pending_checkout',
	'needs_retry',
])
const reclaimLeaseGuard = sqlSourcesOf(planTransferState, 'CLAIM_LEASE', [
	'applying',
])
const releaseLeaseGuard = sqlSourcesOf(planTransferState, 'RELEASE_CHECKOUT', [
	'applying',
])
const completeGuard = sqlSourcesOf(planTransferState, 'COMPLETE', ['applying'])

function blocked(reason: PlanTransferBlockReason): PlanTransferPreviewResult {
	return { ok: false, reason, message: blockMessages[reason] }
}

export function freePlanLimitSummary(): Array<PlanTransferFreeLimit> {
	const free = planLimits.free
	const mb = Math.round(free.maxStorageBytes / (1024 * 1024))
	return [
		{ label: 'Saved packages', value: String(free.maxSavedPackages) },
		{ label: 'Scheduled jobs', value: String(free.maxScheduledJobs) },
		{ label: 'Secrets', value: String(free.maxSecrets) },
		{ label: 'Storage', value: `${mb} MB` },
		{
			label: 'Concurrent workflows',
			value: String(free.maxConcurrentWorkflows),
		},
		{
			label: 'Job runs per day',
			value: free.maxJobRunsPerDay.toLocaleString('en-US'),
		},
		{ label: 'Emails sent per day', value: String(free.maxEmailSendsPerDay) },
		{
			label: 'Shortest job interval',
			value: `${Math.round(free.minJobIntervalMs / 60_000)} minutes`,
		},
	]
}

async function readOrgBillingRow(
	db: D1Database,
	orgId: string,
): Promise<OrgBillingRow | null> {
	return await db
		.prepare(
			`SELECT o.id, o.slug, o.display_name, o.plan, o.stripe_plan,
			        o.stripe_customer_id, o.deleting_at, o.suspended_at,
			        EXISTS (
			          SELECT 1 FROM users u
			          WHERE COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id) = o.id
			        ) AS personal
			 FROM orgs o
			 WHERE o.id = ? AND o.deleted_at IS NULL`,
		)
		.bind(orgId)
		.first<OrgBillingRow>()
}

function isOrgUsable(row: OrgBillingRow | null): row is OrgBillingRow {
	return row != null && !row.deleting_at && !row.suspended_at
}

async function isLiveOwner(db: D1Database, orgId: string, userId: string) {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM org_memberships
			 WHERE org_id = ? AND user_id = ? AND role = 'owner' AND deleted_at IS NULL`,
		)
		.bind(orgId, userId)
		.first<{ ok: number }>()
	return row != null
}

async function listLiveOwnerIds(db: D1Database, orgId: string) {
	const rows = await db
		.prepare(
			`SELECT m.user_id FROM org_memberships m
			 INNER JOIN users u ON u.stable_user_id = m.user_id AND u.deleted_at IS NULL
			 WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL`,
		)
		.bind(orgId)
		.all<{ user_id: string }>()
	return (rows.results ?? []).map((row) => row.user_id)
}

function hasManualPaidPlan(row: OrgBillingRow) {
	return (parsePlanName(row.plan) ?? 'free') !== 'free'
}

function isEffectivelyFree(row: OrgBillingRow) {
	return !isPaidOrgBilling(row)
}

/**
 * The 2-free-orgs rule (ADR 0065) for every live owner of the source once it
 * drops to Free. A target that is still Free in D1 but about to become (or
 * just became) paid no longer counts against an owner who also owns it.
 */
async function checkFreeOrgCap(input: {
	db: D1Database
	source: OrgBillingRow
	target: OrgBillingRow
	actorUserId: string
}): Promise<{ ok: boolean; actorOwnedAfter: number }> {
	const ownerIds = await listLiveOwnerIds(input.db, input.source.id)
	if (!ownerIds.includes(input.actorUserId)) ownerIds.push(input.actorUserId)
	let actorOwnedAfter = 0
	let ok = true
	for (const ownerId of ownerIds) {
		const owned = await countLiveFreeOwnedOrgs(input.db, ownerId)
		const targetRelief =
			isEffectivelyFree(input.target) &&
			(await isLiveOwner(input.db, input.target.id, ownerId))
				? 1
				: 0
		const sourceAlreadyFree = isEffectivelyFree(input.source) ? 1 : 0
		const after = owned - targetRelief - sourceAlreadyFree + 1
		if (ownerId === input.actorUserId) actorOwnedAfter = after
		if (after > MAX_FREE_ORGS_PER_USER) ok = false
	}
	return { ok, actorOwnedAfter }
}

function subscriptionInterval(
	env: PlanTransferEnv,
	subscription: StripeSubscription,
): BillingInterval | null {
	const ids = new Set(subscription.items.data.map((item) => item.price.id))
	if (ids.has(getPriceIdForPlan(env, 'pro', 'year') ?? '')) return 'year'
	if (ids.has(getPriceIdForPlan(env, 'pro', 'month') ?? '')) return 'month'
	return null
}

type SourceSubscriptionState =
	| { ok: true; subscription: StripeSubscription; interval: BillingInterval }
	| { ok: false; reason: PlanTransferBlockReason }

async function readSourceSubscription(
	env: PlanTransferEnv,
	source: OrgBillingRow,
): Promise<SourceSubscriptionState> {
	if (hasManualPaidPlan(source)) {
		return { ok: false, reason: 'source_manual_plan' }
	}
	const customerId = source.stripe_customer_id?.trim()
	if (!customerId) return { ok: false, reason: 'source_not_stripe_pro' }
	const subscriptions = await listSubscriptions(env, customerId)
	const selected = selectPurchasableSeatSubscription(env, subscriptions)
	if (!selected) return { ok: false, reason: 'source_not_stripe_pro' }
	const { subscription } = selected
	if (subscription.status !== 'active') {
		return { ok: false, reason: 'source_not_active' }
	}
	if (subscription.cancel_at != null) {
		return { ok: false, reason: 'source_canceling' }
	}
	const interval = subscriptionInterval(env, subscription)
	if (!interval) return { ok: false, reason: 'source_not_stripe_pro' }
	return { ok: true, subscription, interval }
}

type TargetSubscriptionState =
	| {
			ok: true
			mode: 'existing_subscription'
			subscription: StripeSubscription
			interval: BillingInterval
			customerId: string
	  }
	| { ok: true; mode: 'checkout'; customerId: string | null }
	| { ok: false; reason: PlanTransferBlockReason }

async function readTargetSubscription(
	env: PlanTransferEnv,
	target: OrgBillingRow,
): Promise<TargetSubscriptionState> {
	const customerId = target.stripe_customer_id?.trim() || null
	if (!customerId) {
		if (isPaidOrgBilling(target)) {
			return { ok: false, reason: 'target_unsupported_subscription' }
		}
		return { ok: true, mode: 'checkout', customerId: null }
	}
	const subscriptions = await listSubscriptions(env, customerId)
	const live = selectPlanRetainingSubscriptions(subscriptions)
	// A Stripe customer balance pays any invoice on the customer, so a credit
	// must never land where a non-Kody product could spend it.
	if (live.some((subscription) => !isKodySubscription(env, subscription))) {
		return { ok: false, reason: 'target_customer_shared' }
	}
	if (live.length === 0) {
		if (hasManualPaidPlan(target)) {
			return { ok: false, reason: 'target_unsupported_subscription' }
		}
		return { ok: true, mode: 'checkout', customerId }
	}
	const selected = selectPurchasableSeatSubscription(env, subscriptions)
	if (!selected || selected.subscription.status !== 'active') {
		return { ok: false, reason: 'target_unsupported_subscription' }
	}
	const interval = subscriptionInterval(env, selected.subscription)
	if (!interval) return { ok: false, reason: 'target_unsupported_subscription' }
	return {
		ok: true,
		mode: 'existing_subscription',
		subscription: selected.subscription,
		interval,
		customerId,
	}
}

type UnusedValue =
	| {
			ok: true
			invoiceId: string | null
			lines: Array<CreditNoteLineInput>
			maxCreditMinor: number
			currency: string | null
			existingCreditNote: { id: string; total: number; currency: string } | null
	  }
	| { ok: false }

async function readUnusedValue(input: {
	env: PlanTransferEnv
	subscriptionId: string
	transferId: string | null
	nowSeconds: number
}): Promise<UnusedValue> {
	const invoices = await listPaidInvoicesForSubscription(
		input.env,
		input.subscriptionId,
	)
	const selected = selectRefundableInvoice(invoices, input.nowSeconds)
	if (!selected) {
		return {
			ok: true,
			invoiceId: null,
			lines: [],
			maxCreditMinor: 0,
			currency: null,
			existingCreditNote: null,
		}
	}
	let creditNotes
	try {
		creditNotes = await listCreditNotesForInvoice(
			input.env,
			selected.invoice.id,
		)
	} catch (error) {
		if (error instanceof StripeCreditNoteListIncompleteError)
			return { ok: false }
		throw error
	}
	const existing = input.transferId
		? creditNotes.find((note) =>
				isPlanTransferCreditNote(note, input.transferId ?? ''),
			)
		: undefined
	const lines = selected.lines
		.map((line) => ({
			invoiceLineItemId: line.id,
			amount: computeProratedRefundMinor({
				lineAmount: line.amount,
				periodStart: line.period.start,
				periodEnd: line.period.end,
				nowSeconds: input.nowSeconds,
			}),
		}))
		.filter((line) => line.amount > 0)
	return {
		ok: true,
		invoiceId: selected.invoice.id,
		lines,
		maxCreditMinor: computeMaxRefundMinor(selected.invoice, creditNotes),
		currency: selected.invoice.currency,
		existingCreditNote: existing
			? { id: existing.id, total: existing.total, currency: existing.currency }
			: null,
	}
}

async function hasOpenTransfer(db: D1Database, orgIds: Array<string>) {
	const row = await db
		.prepare(
			`SELECT id FROM org_plan_transfers
			 WHERE status IN ${openStatusSql}
			   AND (source_org_id IN (?, ?) OR target_org_id IN (?, ?))
			 LIMIT 1`,
		)
		.bind(orgIds[0], orgIds[1], orgIds[0], orgIds[1])
		.first<{ id: string }>()
	return row?.id ?? null
}

type ValidatedTransfer = {
	source: OrgBillingRow
	target: OrgBillingRow
	sourceSubscription: Extract<SourceSubscriptionState, { ok: true }>
	targetSubscription: Extract<TargetSubscriptionState, { ok: true }>
	actorOwnedFreeAfter: number
}

async function validateTransfer(input: {
	env: PlanTransferEnv
	actorUserId: string
	sourceOrgId: string
	targetOrgId: string
	ignoreOpenTransferId?: string
}): Promise<
	| { ok: true; value: ValidatedTransfer }
	| { ok: false; reason: PlanTransferBlockReason }
> {
	const db = input.env.APP_DB
	if (!isBillingConfigured(input.env)) {
		return { ok: false, reason: 'billing_not_configured' }
	}
	if (input.sourceOrgId === input.targetOrgId) {
		return { ok: false, reason: 'same_org' }
	}
	const [source, target] = await Promise.all([
		readOrgBillingRow(db, input.sourceOrgId),
		readOrgBillingRow(db, input.targetOrgId),
	])
	if (!isOrgUsable(source)) return { ok: false, reason: 'source_unavailable' }
	if (!isOrgUsable(target)) return { ok: false, reason: 'target_unavailable' }
	if (!(await isLiveOwner(db, source.id, input.actorUserId))) {
		return { ok: false, reason: 'not_owner_source' }
	}
	if (!(await isLiveOwner(db, target.id, input.actorUserId))) {
		return { ok: false, reason: 'not_owner_target' }
	}
	const openId = await hasOpenTransfer(db, [source.id, target.id])
	if (openId && openId !== input.ignoreOpenTransferId) {
		return { ok: false, reason: 'transfer_in_progress' }
	}
	const sourceSubscription = await readSourceSubscription(input.env, source)
	if (!sourceSubscription.ok) return sourceSubscription
	const targetSubscription = await readTargetSubscription(input.env, target)
	if (!targetSubscription.ok) return targetSubscription
	if (
		targetSubscription.mode === 'existing_subscription' &&
		sourceSubscription.subscription.currency &&
		targetSubscription.subscription.currency &&
		sourceSubscription.subscription.currency.toLowerCase() !==
			targetSubscription.subscription.currency.toLowerCase()
	) {
		return { ok: false, reason: 'currency_mismatch' }
	}
	const cap = await checkFreeOrgCap({
		db,
		source,
		target,
		actorUserId: input.actorUserId,
	})
	if (!cap.ok) return { ok: false, reason: 'free_org_limit' }
	return {
		ok: true,
		value: {
			source,
			target,
			sourceSubscription,
			targetSubscription,
			actorOwnedFreeAfter: cap.actorOwnedAfter,
		},
	}
}

function toOrgSummary(
	row: OrgBillingRow,
	seats: number,
): PlanTransferOrgSummary {
	return {
		id: row.id,
		slug: row.slug,
		displayName: row.display_name,
		personal: Boolean(row.personal),
		seats,
	}
}

/**
 * Read-only: validates the move and estimates the credit with a Stripe
 * credit note preview. Nothing in Stripe or D1 changes.
 */
export async function previewPlanTransfer(input: {
	env: PlanTransferEnv
	actorUserId: string
	sourceOrgId: string
	targetOrgId: string
	targetInterval?: BillingInterval | null
	now?: Date
}): Promise<PlanTransferPreviewResult> {
	const validated = await validateTransfer(input)
	if (!validated.ok) return blocked(validated.reason)
	const { source, target, sourceSubscription, targetSubscription } =
		validated.value
	const nowSeconds = Math.floor((input.now ?? new Date()).valueOf() / 1000)
	const unused = await readUnusedValue({
		env: input.env,
		subscriptionId: sourceSubscription.subscription.id,
		transferId: null,
		nowSeconds,
	})
	if (!unused.ok) return blocked('credit_unavailable')
	let creditMinor = 0
	if (
		unused.invoiceId &&
		unused.lines.length > 0 &&
		unused.maxCreditMinor > 0
	) {
		const preview = await previewPlanTransferCreditNote(input.env, {
			invoiceId: unused.invoiceId,
			lines: unused.lines,
			maxCreditMinor: unused.maxCreditMinor,
		})
		if (preview.outcome === 'unfittable') return blocked('credit_unavailable')
		if (preview.outcome === 'previewed') creditMinor = preview.total
	}
	const [sourceSeats, targetSeats, wallet] = await Promise.all([
		countLiveSeats(input.env.APP_DB, source.id),
		countLiveSeats(input.env.APP_DB, target.id),
		readCreditWallet(input.env.APP_DB, source.id),
	])
	const seats = Math.max(1, targetSeats)
	const interval =
		targetSubscription.mode === 'existing_subscription'
			? targetSubscription.interval
			: (input.targetInterval ?? sourceSubscription.interval)
	const pricePerSeatMinor = proSeatPriceMinor[interval]
	const periodEnd = readStripeSubscriptionPeriodEndUnix(
		sourceSubscription.subscription,
	)
	return {
		ok: true,
		preview: {
			source: {
				...toOrgSummary(source, Math.max(1, sourceSeats)),
				interval: sourceSubscription.interval,
				periodEndAt: periodEnd
					? new Date(periodEnd * 1000).toISOString()
					: null,
				walletBalanceMicroUsd: wallet.balanceMicroUsd,
			},
			target: {
				...toOrgSummary(target, seats),
				mode: targetSubscription.mode,
				interval,
				pricePerSeatMinor,
				dueTodayMinor:
					targetSubscription.mode === 'checkout'
						? pricePerSeatMinor * seats
						: 0,
				recurringMinor: pricePerSeatMinor * seats,
			},
			credit: {
				amountMinor: creditMinor,
				currency: unused.currency ?? 'usd',
			},
			freeLimits: freePlanLimitSummary(),
			freeOrgsAfter: {
				owned: validated.value.actorOwnedFreeAfter,
				max: MAX_FREE_ORGS_PER_USER,
			},
		},
	}
}

export async function readPlanTransfer(
	db: D1Database,
	transferId: string,
): Promise<PlanTransferRow | null> {
	return await db
		.prepare(`SELECT * FROM org_plan_transfers WHERE id = ?`)
		.bind(transferId)
		.first<PlanTransferRow>()
}

/** The open (or most recent) transfer touching an org, for the billing UI. */
export async function readLatestPlanTransferForOrg(
	db: D1Database,
	orgId: string,
): Promise<PlanTransferRow | null> {
	return await db
		.prepare(
			`SELECT * FROM org_plan_transfers
			 WHERE source_org_id = ? OR target_org_id = ?
			 ORDER BY (status IN ${openStatusSql}) DESC,
			          created_at DESC
			 LIMIT 1`,
		)
		.bind(orgId, orgId)
		.first<PlanTransferRow>()
}

export type PlanTransferOutcome =
	| { ok: true; transfer: PlanTransferRow; checkoutUrl?: string }
	| { ok: false; reason: PlanTransferBlockReason; message: string }

function isUniqueConstraintError(error: unknown) {
	return /UNIQUE constraint failed/i.test(
		error instanceof Error ? error.message : String(error),
	)
}

/**
 * Starts (or, for a repeated `transferId`, returns) a plan move. With an
 * existing Pro subscription on the target the move finishes now; otherwise
 * the owner pays for the target at Stripe Checkout first and the move
 * finishes when that checkout completes.
 */
export async function startPlanTransfer(input: {
	env: PlanTransferEnv
	actorUserId: string
	actorEmail: string | null
	transferId: string
	sourceOrgId: string
	targetOrgId: string
	targetInterval: BillingInterval
	origin: string
	now?: Date
}): Promise<PlanTransferOutcome> {
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const existing = await readPlanTransfer(db, input.transferId)
	if (existing) {
		if (
			existing.requested_by_user_id !== input.actorUserId ||
			existing.source_org_id !== input.sourceOrgId ||
			existing.target_org_id !== input.targetOrgId
		) {
			return blocked('transfer_in_progress') as PlanTransferOutcome
		}
		return { ok: true, transfer: existing }
	}
	const validated = await validateTransfer(input)
	if (!validated.ok) return blocked(validated.reason) as PlanTransferOutcome
	const { source, target, sourceSubscription, targetSubscription } =
		validated.value
	const interval =
		targetSubscription.mode === 'existing_subscription'
			? targetSubscription.interval
			: input.targetInterval
	const nowIso = now.toISOString()
	try {
		await db
			.prepare(
				`INSERT INTO org_plan_transfers (
					id, source_org_id, target_org_id, requested_by_user_id, status,
					target_interval, source_subscription_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				input.transferId,
				source.id,
				target.id,
				input.actorUserId,
				targetSubscription.mode === 'checkout'
					? 'pending_checkout'
					: 'needs_retry',
				interval,
				sourceSubscription.subscription.id,
				nowIso,
				nowIso,
			)
			.run()
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error
		const raced = await readPlanTransfer(db, input.transferId)
		if (raced && raced.requested_by_user_id === input.actorUserId) {
			return { ok: true, transfer: raced }
		}
		return blocked('transfer_in_progress') as PlanTransferOutcome
	}
	await auditTransfer(input.env, {
		transferId: input.transferId,
		sourceOrgId: source.id,
		targetOrgId: target.id,
		actorUserId: input.actorUserId,
		action: 'billing_plan_transfer_started',
		result: 'success',
		details: { mode: targetSubscription.mode, interval },
	})

	if (targetSubscription.mode === 'existing_subscription') {
		const transfer = await advancePlanTransfer({
			env: input.env,
			transferId: input.transferId,
			now,
		})
		return {
			ok: true,
			transfer: transfer ?? (await mustRead(db, input.transferId)),
		}
	}

	const priceId = getPriceIdForPlan(input.env, 'pro', interval)
	if (!priceId) {
		await markCanceled(db, input.transferId, 'billing_not_configured', now)
		return blocked('billing_not_configured') as PlanTransferOutcome
	}
	const seats = Math.max(1, await countLiveSeats(db, target.id))
	const expiresAtUnix =
		Math.floor(now.valueOf() / 1000) + checkoutLifetimeSeconds
	try {
		const session = await createCheckoutSession(input.env, {
			priceId,
			quantity: seats,
			clientReferenceId: await createBillingLinkReference(input.env, target.id),
			successUrl: `${input.origin}/@${target.slug}/-/billing/success?session_id={CHECKOUT_SESSION_ID}`,
			cancelUrl: `${input.origin}/@${source.slug}/-/billing/move-plan?to=${encodeURIComponent(target.slug)}&billing=plan_transfer_checkout_canceled`,
			customerId: targetSubscription.customerId ?? undefined,
			customerEmail: targetSubscription.customerId
				? undefined
				: (input.actorEmail ?? undefined),
			metadata: {
				...buildOrgBillingMetadata(target.id),
				kody_plan: 'pro',
				[planTransferMetadataKey]: input.transferId,
			},
			expiresAtUnix,
		})
		await db
			.prepare(
				`UPDATE org_plan_transfers
				 SET checkout_session_id = ?, checkout_expires_at = ?, updated_at = ?
				 WHERE id = ? AND status = 'pending_checkout'`,
			)
			.bind(
				session.id,
				new Date(expiresAtUnix * 1000).toISOString(),
				nowIso,
				input.transferId,
			)
			.run()
		return {
			ok: true,
			transfer: await mustRead(db, input.transferId),
			checkoutUrl: session.url,
		}
	} catch (error) {
		await markCanceled(db, input.transferId, 'checkout_failed', now)
		throw error
	}
}

async function mustRead(db: D1Database, transferId: string) {
	const row = await readPlanTransfer(db, transferId)
	if (!row) throw new Error(`Plan transfer ${transferId} disappeared.`)
	return row
}

async function markCanceled(
	db: D1Database,
	transferId: string,
	code: string,
	now: Date,
) {
	await db
		.prepare(
			`UPDATE org_plan_transfers
			 SET status = 'canceled', last_error_code = ?, lease_expires_at = NULL, updated_at = ?
			 WHERE id = ? AND credit_amount_minor IS NULL
			   AND status IN ${cancelOpenGuard}`,
		)
		.bind(code, now.toISOString(), transferId)
		.run()
}

/**
 * Cancels a move that has not reached the point of no return. A target
 * subscription bought at Checkout stays; the owner manages it in the portal.
 */
export async function cancelPlanTransfer(input: {
	env: PlanTransferEnv
	actorUserId: string
	transferId: string
	now?: Date
}): Promise<{ ok: boolean; transfer: PlanTransferRow | null }> {
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const row = await readPlanTransfer(db, input.transferId)
	if (!row) return { ok: false, transfer: null }
	if (
		!(await isLiveOwner(db, row.source_org_id, input.actorUserId)) &&
		!(await isLiveOwner(db, row.target_org_id, input.actorUserId))
	) {
		return { ok: false, transfer: null }
	}
	const result = await db
		.prepare(
			`UPDATE org_plan_transfers
			 SET status = 'canceled', last_error_code = 'canceled_by_owner',
			     lease_expires_at = NULL, updated_at = ?
			 WHERE id = ? AND credit_amount_minor IS NULL
			   AND (status IN ${cancelUnleasedGuard}
			        OR (status IN ${cancelExpiredLeaseGuard} AND lease_expires_at < ?))`,
		)
		.bind(now.toISOString(), input.transferId, now.toISOString())
		.run()
	const ok = (result.meta.changes ?? 0) > 0
	if (ok) {
		await auditTransfer(input.env, {
			transferId: row.id,
			sourceOrgId: row.source_org_id,
			targetOrgId: row.target_org_id,
			actorUserId: input.actorUserId,
			action: 'billing_plan_transfer_canceled',
			result: 'success',
		})
	}
	return { ok, transfer: await readPlanTransfer(db, input.transferId) }
}

async function claimLease(db: D1Database, transferId: string, now: Date) {
	const nowIso = now.toISOString()
	const leaseExpiresAt = new Date(now.valueOf() + leaseMs).toISOString()
	const result = await db
		.prepare(
			`UPDATE org_plan_transfers
			 SET status = 'applying', lease_expires_at = ?, updated_at = ?
			 WHERE id = ?
			   AND (status IN ${claimLeaseGuard}
			        OR (status IN ${reclaimLeaseGuard} AND lease_expires_at < ?))`,
		)
		.bind(leaseExpiresAt, nowIso, transferId, nowIso)
		.run()
	return (result.meta.changes ?? 0) > 0 ? leaseExpiresAt : null
}

async function releaseLease(
	db: D1Database,
	transferId: string,
	leaseExpiresAt: string,
	status: 'pending_checkout' | 'needs_retry' | 'canceled',
	code: string | null,
	now: Date,
) {
	const result = await db
		.prepare(
			`UPDATE org_plan_transfers
			 SET status = ?, last_error_code = ?, lease_expires_at = NULL, updated_at = ?
			 WHERE id = ? AND status IN ${releaseLeaseGuard} AND lease_expires_at = ?`,
		)
		.bind(status, code, now.toISOString(), transferId, leaseExpiresAt)
		.run()
	return (result.meta.changes ?? 0) > 0
}

async function updateStep(
	db: D1Database,
	transferId: string,
	leaseExpiresAt: string,
	columns: Record<string, string | number | null>,
	now: Date,
) {
	const entries = Object.entries(columns)
	const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
	const result = await db
		.prepare(
			`UPDATE org_plan_transfers SET ${assignments}, updated_at = ?
			 WHERE id = ? AND status = 'applying' AND lease_expires_at = ?`,
		)
		.bind(
			...entries.map(([, value]) => value),
			now.toISOString(),
			transferId,
			leaseExpiresAt,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

function errorCode(error: unknown) {
	if (error instanceof StripeApiError) {
		return `stripe_${error.status}${error.code ? `_${error.code}` : ''}`.slice(
			0,
			80,
		)
	}
	return 'internal_error'
}

/**
 * Drives a transfer forward from whatever step it last recorded. Safe to call
 * from any number of places at once: only the caller holding the lease does
 * work, and every Stripe write is either looked up first or idempotency-keyed.
 * Returns the row as it stands afterward (null when it does not exist).
 */
export async function advancePlanTransfer(input: {
	env: PlanTransferEnv
	transferId: string
	now?: Date
}): Promise<PlanTransferRow | null> {
	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	const row = await readPlanTransfer(db, input.transferId)
	if (!row) return null
	if (!openStatuses.includes(row.status)) return row
	const leaseExpiresAt = await claimLease(db, row.id, now)
	if (!leaseExpiresAt) return await readPlanTransfer(db, row.id)
	const wasPendingCheckout = row.status === 'pending_checkout'

	try {
		if (row.credit_amount_minor == null) {
			const validated = await validateTransfer({
				env: input.env,
				actorUserId: row.requested_by_user_id,
				sourceOrgId: row.source_org_id,
				targetOrgId: row.target_org_id,
				ignoreOpenTransferId: row.id,
			})
			if (!validated.ok) {
				await releaseLease(
					db,
					row.id,
					leaseExpiresAt,
					'needs_retry',
					validated.reason,
					now,
				)
				return await readPlanTransfer(db, row.id)
			}
			if (validated.value.targetSubscription.mode === 'checkout') {
				const expiresAt = row.checkout_expires_at
					? Date.parse(row.checkout_expires_at)
					: null
				if (
					wasPendingCheckout &&
					expiresAt != null &&
					now.valueOf() > expiresAt + checkoutExpiryGraceMs
				) {
					await releaseLease(
						db,
						row.id,
						leaseExpiresAt,
						'canceled',
						'checkout_expired',
						now,
					)
				} else {
					await releaseLease(
						db,
						row.id,
						leaseExpiresAt,
						wasPendingCheckout ? 'pending_checkout' : 'needs_retry',
						wasPendingCheckout ? null : 'target_not_paid',
						now,
					)
				}
				return await readPlanTransfer(db, row.id)
			}
			if (
				validated.value.sourceSubscription.subscription.id !==
				row.source_subscription_id
			) {
				await releaseLease(
					db,
					row.id,
					leaseExpiresAt,
					'needs_retry',
					'source_not_stripe_pro',
					now,
				)
				return await readPlanTransfer(db, row.id)
			}
			const unused = await readUnusedValue({
				env: input.env,
				subscriptionId: row.source_subscription_id,
				transferId: row.id,
				nowSeconds: Math.floor(now.valueOf() / 1000),
			})
			if (!unused.ok) {
				await releaseLease(
					db,
					row.id,
					leaseExpiresAt,
					'needs_retry',
					'credit_unavailable',
					now,
				)
				return await readPlanTransfer(db, row.id)
			}
			let credit = unused.existingCreditNote
			if (
				!credit &&
				unused.invoiceId &&
				unused.lines.length > 0 &&
				unused.maxCreditMinor > 0
			) {
				const issued = await createPlanTransferCreditNote(input.env, {
					invoiceId: unused.invoiceId,
					subscriptionId: row.source_subscription_id,
					transferId: row.id,
					lines: unused.lines,
					maxCreditMinor: unused.maxCreditMinor,
				})
				if (issued.outcome === 'unfittable') {
					await releaseLease(
						db,
						row.id,
						leaseExpiresAt,
						'needs_retry',
						'credit_unavailable',
						now,
					)
					return await readPlanTransfer(db, row.id)
				}
				if (issued.outcome === 'issued') {
					credit = {
						id: issued.id,
						total: issued.total,
						currency: issued.currency,
					}
				}
			}
			if (
				!(await updateStep(
					db,
					row.id,
					leaseExpiresAt,
					{
						credit_amount_minor: credit?.total ?? 0,
						currency: credit?.currency ?? unused.currency,
						source_invoice_id: unused.invoiceId,
						source_credit_note_id: credit?.id ?? null,
						last_error_code: null,
					},
					now,
				))
			)
				return await readPlanTransfer(db, row.id)
		}

		let current = await mustRead(db, row.id)
		if (
			current.status !== 'applying' ||
			current.lease_expires_at !== leaseExpiresAt
		)
			return current
		const source = await readOrgBillingRow(db, current.source_org_id)
		const target = await readOrgBillingRow(db, current.target_org_id)
		if (!current.source_canceled_at) {
			await cancelSourceSubscription(
				input.env,
				source,
				current.source_subscription_id,
			)
			if (
				!(await updateStep(
					db,
					row.id,
					leaseExpiresAt,
					{ source_canceled_at: now.toISOString() },
					now,
				))
			)
				return await readPlanTransfer(db, row.id)
		}

		current = await mustRead(db, row.id)
		if (
			current.status !== 'applying' ||
			current.lease_expires_at !== leaseExpiresAt
		)
			return current
		const creditMinor = current.credit_amount_minor ?? 0
		if (creditMinor > 0 && !current.target_balance_transaction_id) {
			const customerId = target?.stripe_customer_id?.trim()
			if (!customerId) throw new Error('Target org has no Stripe customer.')
			const transactionId = await creditTargetBalance(input.env, {
				customerId,
				transfer: current,
				amountMinor: creditMinor,
				sourceSlug: source?.slug ?? null,
			})
			if (
				!(await updateStep(
					db,
					row.id,
					leaseExpiresAt,
					{ target_balance_transaction_id: transactionId },
					now,
				))
			)
				return await readPlanTransfer(db, row.id)
		}

		const completed = await db
			.prepare(
				`UPDATE org_plan_transfers
				 SET status = 'completed', completed_at = ?, lease_expires_at = NULL,
				     last_error_code = NULL, updated_at = ?
				 WHERE id = ? AND status IN ${completeGuard} AND lease_expires_at = ?`,
			)
			.bind(now.toISOString(), now.toISOString(), row.id, leaseExpiresAt)
			.run()
		current = await mustRead(db, row.id)
		if (!(completed.meta.changes ?? 0)) return current
		await refreshBothOrgs(input.env, source, target, now)
		await auditTransfer(input.env, {
			transferId: row.id,
			sourceOrgId: current.source_org_id,
			targetOrgId: current.target_org_id,
			actorUserId: current.requested_by_user_id,
			action: 'billing_plan_transfer_completed',
			result: 'success',
			details: {
				creditMinor: current.credit_amount_minor,
				currency: current.currency,
				interval: current.target_interval,
			},
		})
		return current
	} catch (error) {
		const code = errorCode(error)
		console.error('billing_plan_transfer_step_failed', {
			transferId: row.id,
			code,
		})
		await releaseLease(db, row.id, leaseExpiresAt, 'needs_retry', code, now)
		return await readPlanTransfer(db, row.id)
	}
}

async function cancelSourceSubscription(
	env: PlanTransferEnv,
	source: OrgBillingRow | null,
	subscriptionId: string,
) {
	const customerId = source?.stripe_customer_id?.trim()
	if (customerId) {
		const subscriptions = await listSubscriptions(env, customerId)
		const match = subscriptions.find((sub) => sub.id === subscriptionId)
		if (match?.status === 'canceled') return
	}
	await cancelSubscription(env, subscriptionId)
}

async function creditTargetBalance(
	env: PlanTransferEnv,
	input: {
		customerId: string
		transfer: PlanTransferRow
		amountMinor: number
		sourceSlug: string | null
	},
) {
	const { transactions } = await listCustomerBalanceTransactions(
		env,
		input.customerId,
	)
	const existing = transactions.find(
		(transaction) =>
			transaction.metadata?.[planTransferMetadataKey] === input.transfer.id,
	)
	if (existing) return existing.id
	const created = await createCustomerBalanceCredit(env, {
		customerId: input.customerId,
		amountMinor: input.amountMinor,
		currency: input.transfer.currency ?? 'usd',
		description: input.sourceSlug
			? `Unused Pro time moved from @${input.sourceSlug}`
			: 'Unused Pro time moved from another Kody organization',
		metadata: {
			[planTransferMetadataKey]: input.transfer.id,
			...buildOrgBillingMetadata(input.transfer.target_org_id),
		},
		idempotencyKey: `kody-plan-transfer-${input.transfer.id}-balance`,
	})
	return created.id
}

async function refreshBothOrgs(
	env: PlanTransferEnv,
	source: OrgBillingRow | null,
	target: OrgBillingRow | null,
	now: Date,
) {
	for (const org of [source, target]) {
		const customerId = org?.stripe_customer_id?.trim()
		if (!org || !customerId) continue
		try {
			await refreshStripePlanForOrg({
				env,
				orgId: org.id as OwnerId,
				customerId,
				now,
			})
		} catch (error) {
			// Webhooks and the refresh backstop converge the plan columns.
			console.warn('billing_plan_transfer_refresh_failed', {
				orgId: org.id,
				code: errorCode(error),
			})
		}
	}
}

async function auditTransfer(
	env: PlanTransferEnv,
	input: {
		transferId: string
		sourceOrgId: string
		targetOrgId: string
		actorUserId: string
		action: string
		result: 'success' | 'failure'
		details?: Record<string, unknown>
	},
) {
	for (const [orgId, role] of [
		[input.sourceOrgId, 'source'],
		[input.targetOrgId, 'target'],
	] as const) {
		try {
			await logOrgAuditEvent({
				env,
				orgId,
				action: input.action,
				result: input.result,
				actorUserId: input.actorUserId,
				resourceType: 'org_plan_transfer',
				resourceId: input.transferId,
				details: {
					role,
					sourceOrgId: input.sourceOrgId,
					targetOrgId: input.targetOrgId,
					...input.details,
				},
			})
		} catch (error) {
			console.warn('billing_plan_transfer_audit_failed', { orgId, error })
		}
	}
}

/**
 * Resumes the transfer a completed Checkout session belongs to. Called from
 * the success redirect and the `checkout.session.completed` webhook after
 * the target customer is linked.
 */
export async function advancePlanTransferForCheckoutSession(input: {
	env: PlanTransferEnv
	sessionId: string
	transferId?: string | null
	now?: Date
}) {
	const row = input.transferId
		? await readPlanTransfer(input.env.APP_DB, input.transferId)
		: await input.env.APP_DB.prepare(
				`SELECT * FROM org_plan_transfers WHERE checkout_session_id = ? LIMIT 1`,
			)
				.bind(input.sessionId)
				.first<PlanTransferRow>()
	if (!row || row.checkout_session_id !== input.sessionId) return null
	return await advancePlanTransfer({
		env: input.env,
		transferId: row.id,
		now: input.now,
	})
}

/** Opportunistic recovery on billing page loads for either org. */
export async function resumeOpenPlanTransferForOrg(input: {
	env: PlanTransferEnv
	orgId: string
	now?: Date
}) {
	const row = await readLatestPlanTransferForOrg(input.env.APP_DB, input.orgId)
	if (!row || !openStatuses.includes(row.status)) return row
	// A needs_retry row blocked by validation waits for the owner; only
	// resume rows that past the point of no return or are waiting on Checkout.
	if (row.status === 'needs_retry' && row.credit_amount_minor == null)
		return row
	return await advancePlanTransfer({
		env: input.env,
		transferId: row.id,
		now: input.now,
	})
}
