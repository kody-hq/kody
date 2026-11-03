import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { decideCreditAutoRefill } from '#universal/credits.ts'
import { isBillingConfigured } from './billing-config.ts'
import {
	applyCreditPayment,
	countCreditAutoRefills,
	markCreditAutoRefillFailed,
	readCreditWallet,
	sumCreditAutoRefillCents,
} from './credit-wallet.ts'
import {
	sendCreditAutoRefilledEmail,
	sendCreditMonthlyCapEmail,
} from '#app/user-account-emails.ts'
import { sendToOrgBillingRecipients } from './org-billing-emails.ts'
import {
	buildOrgBillingMetadata,
	resolveOrgIdFromStripeMetadata,
} from './org-stripe-metadata.ts'
import {
	createOffSessionPaymentIntent,
	isStripeIdempotencyParameterMismatchError,
	listPaymentIntentsForCustomer,
	StripeApiError,
	type StripePaymentIntent,
	type StripePaymentIntentListItem,
} from './stripe-client.ts'

export const creditAutoRefillMetadataKey = 'kody_credit_auto_refill'

export type CreditAutoRefillOutcome =
	| 'charged'
	| 'skipped'
	| 'cap_reached'
	| 'failed'

/**
 * Stable Stripe idempotency key for one auto-refill slot. Keep the shape
 * unchanged across metadata dual-write so Stripe can return a cached intent
 * when parameters are replayed for a deploy-boundary retry (#3679).
 */
export function buildCreditAutoRefillIdempotencyKey(input: {
	userId: string
	month: string
	refillNumber: number
}): string {
	return `kody-credit-auto-refill:${input.userId}:${input.month}:${input.refillNumber}`
}

async function creditLedgerHasStripeReference(
	db: D1Database,
	stripeReference: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS ok FROM credit_ledger_entries WHERE stripe_reference = ? LIMIT 1`,
		)
		.bind(stripeReference)
		.first()
	return row != null
}

function isSucceededAutoRefillPaymentIntentForOrg(
	intent: Pick<StripePaymentIntentListItem, 'status' | 'currency' | 'metadata'>,
	orgId: string,
): boolean {
	if (intent.status !== 'succeeded' || intent.currency !== 'usd') return false
	const metadata = intent.metadata ?? {}
	if (metadata[creditAutoRefillMetadataKey] !== '1') return false
	return resolveOrgIdFromStripeMetadata(metadata) === orgId
}

/**
 * Newest-first Stripe list may include auto-refills from a prior UTC month.
 * applyCreditPayment still stamps the ledger with the caller `now` month
 * (pre-existing wallet behavior); prefer healing the paid intent over leaving
 * it uncredited.
 */
async function findUnledgeredSucceededAutoRefillPaymentIntent(input: {
	env: Env
	db: D1Database
	customerId: string
	orgId: string
}): Promise<StripePaymentIntent | null> {
	const intents = await listPaymentIntentsForCustomer(
		input.env,
		input.customerId,
	)
	for (const intent of intents) {
		if (!isSucceededAutoRefillPaymentIntentForOrg(intent, input.orgId)) {
			continue
		}
		if (await creditLedgerHasStripeReference(input.db, intent.id)) continue
		return intent
	}
	return null
}

async function tryFindUnledgeredSucceededAutoRefillPaymentIntent(input: {
	env: Env
	db: D1Database
	customerId: string
	orgId: string
}): Promise<StripePaymentIntent | null> {
	try {
		return await findUnledgeredSucceededAutoRefillPaymentIntent(input)
	} catch (error) {
		if (!(error instanceof StripeApiError)) throw error
		console.warn('credit_auto_refill_list_reconcile_failed', {
			status: error.status,
			code: error.code,
		})
		return null
	}
}

async function applySucceededAutoRefillPaymentIntent(input: {
	env: Env
	db: D1Database
	userId: string
	intent: StripePaymentIntent
	notifyAutoRefilled: boolean
	now: Date
}): Promise<CreditAutoRefillOutcome> {
	if (input.intent.status !== 'succeeded' || input.intent.currency !== 'usd') {
		await markCreditAutoRefillFailed({
			db: input.db,
			userId: input.userId,
			now: input.now,
		})
		return 'failed'
	}
	const result = await applyCreditPayment({
		db: input.db,
		userId: input.userId,
		kind: 'auto_refill',
		amountCents: input.intent.amount,
		stripeReference: input.intent.id,
		now: input.now,
	})
	if (result.applied && input.notifyAutoRefilled) {
		await sendToOrgBillingRecipients({
			db: input.db,
			orgId: input.userId,
			sendOne: async (recipient) => {
				await sendCreditAutoRefilledEmail({
					env: input.env,
					email: recipient.email,
					userId: recipient.userId,
					paymentIntentId: input.intent.id,
					amountCents: input.intent.amount,
					balanceMicroUsd: result.balanceMicroUsd,
				})
			},
		}).catch((error: unknown) => {
			console.warn('credit-auto-refilled-email-failed', error)
		})
	}
	return 'charged'
}

async function createAutoRefillPaymentIntent(input: {
	env: Env
	db: D1Database
	customerId: string
	paymentMethodId: string
	userId: string
	month: string
	refillNumber: number
	amountCents: number
}): Promise<StripePaymentIntent> {
	const idempotencyKey = buildCreditAutoRefillIdempotencyKey({
		userId: input.userId,
		month: input.month,
		refillNumber: input.refillNumber,
	})
	const chargeInput = {
		customerId: input.customerId,
		paymentMethodId: input.paymentMethodId,
		amountCents: input.amountCents,
		description: 'Kody credits auto-refill',
	}
	const reconciled = await tryFindUnledgeredSucceededAutoRefillPaymentIntent({
		env: input.env,
		db: input.db,
		customerId: input.customerId,
		orgId: input.userId,
	})
	if (reconciled) return reconciled

	try {
		return await createOffSessionPaymentIntent(input.env, {
			...chargeInput,
			idempotencyKey,
			metadata: {
				[creditAutoRefillMetadataKey]: '1',
				...buildOrgBillingMetadata(input.userId),
			},
		})
	} catch (error) {
		if (!(error instanceof StripeApiError)) throw error
		if (!isStripeIdempotencyParameterMismatchError(error)) throw error
		// The key is already bound to an intent created with other parameters
		// (e.g. different metadata before a deploy). Heal from the list instead.
		const fromList = await tryFindUnledgeredSucceededAutoRefillPaymentIntent({
			env: input.env,
			db: input.db,
			customerId: input.customerId,
			orgId: input.userId,
		})
		if (fromList) return fromList
		throw error
	}
}

/**
 * Charge one auto-refill when the wallet is at or under its threshold.
 * Callers only invoke this for wallet-eligible Pro accounts. The Stripe
 * idempotency key is per (user, month, refill number), so a retried lane
 * cannot charge the same refill twice.
 */
export async function runCreditAutoRefill(input: {
	env: Env
	userId: string
	email: string
	stripeCustomerId: string | null
	now: Date
}): Promise<CreditAutoRefillOutcome> {
	const db = input.env.APP_DB
	const month = utcMonthKey(input.now)
	const wallet = await readCreditWallet(db, input.userId)
	if (!wallet.autoRefill.enabled) return 'skipped'
	const refilledThisMonthCents = await sumCreditAutoRefillCents({
		db,
		userId: input.userId,
		month,
	})
	const customerId = input.stripeCustomerId?.trim() || null
	const decision = decideCreditAutoRefill({
		settings: wallet.autoRefill,
		balanceMicroUsd: wallet.balanceMicroUsd,
		refilledThisMonthCents,
		hasPaymentMethod: Boolean(wallet.autoRefillPaymentMethodId && customerId),
		lastFailedAt: wallet.autoRefillFailedAt,
		now: input.now,
	})
	switch (decision.action) {
		case 'skip':
			return 'skipped'
		case 'cap_reached':
			if (wallet.notify.monthlyCap) {
				await sendToOrgBillingRecipients({
					db,
					orgId: input.userId,
					sendOne: async (recipient) => {
						await sendCreditMonthlyCapEmail({
							env: input.env,
							email: recipient.email,
							userId: recipient.userId,
							month,
						})
					},
				}).catch((error: unknown) => {
					console.warn('credit-monthly-cap-email-failed', error)
				})
			}
			return 'cap_reached'
		case 'charge':
			break
		default: {
			const exhaustive: never = decision
			throw new Error(`Unknown auto-refill decision: ${String(exhaustive)}`)
		}
	}
	if (!isBillingConfigured(input.env) || !customerId) return 'skipped'
	const paymentMethodId = wallet.autoRefillPaymentMethodId
	if (!paymentMethodId) return 'skipped'
	const refillNumber =
		(await countCreditAutoRefills({ db, userId: input.userId, month })) + 1
	try {
		const intent = await createAutoRefillPaymentIntent({
			env: input.env,
			db,
			customerId,
			paymentMethodId,
			userId: input.userId,
			month,
			refillNumber,
			amountCents: decision.amountCents,
		})
		return await applySucceededAutoRefillPaymentIntent({
			env: input.env,
			db,
			userId: input.userId,
			intent,
			notifyAutoRefilled: wallet.notify.autoRefilled,
			now: input.now,
		})
	} catch (error) {
		if (!(error instanceof StripeApiError)) throw error
		console.error('credit_auto_refill_failed', {
			status: error.status,
			code: error.code,
		})
		await markCreditAutoRefillFailed({
			db,
			userId: input.userId,
			now: input.now,
		})
		return 'failed'
	}
}
