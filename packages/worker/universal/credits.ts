/**
 * Prepaid credit wallet rules shared by the worker and the account UI.
 *
 * Money is integer micro-USD (1 USD = 1,000,000) so sub-cent debit rates
 * stay exact. Top-ups and auto-refill settings are whole cents (Stripe
 * amounts). Wallet eligibility and unlock live on `plans.ts`
 * (`CreditWalletState`); this module is amounts, rates, and guards.
 */
export const microUsdPerCent = 10_000

/**
 * Meters a wallet debits past the monthly include. Stored as open TEXT in
 * D1 (`credit_ledger_entries.meter`, `credit_debit_progress.meter`) so CPU,
 * then storage/email, can join without a schema change.
 */
export const creditDebitMeters = [
	'unique_worker_days',
	'durable_object_rows_read',
] as const

export type CreditDebitMeter = (typeof creditDebitMeters)[number]

type CreditDebitRate = {
	/** Price in micro-USD for `unitsPerPrice` units. */
	priceMicroUsd: number
	unitsPerPrice: number
	/** Human rate for UI and email copy. */
	label: string
}

/**
 * About 2× Cloudflare list. Customer copy uses “Worker compute” /
 * “Rows read” — never UWD jargon.
 */
export const creditDebitRates = {
	unique_worker_days: {
		priceMicroUsd: 4_000,
		unitsPerPrice: 1,
		label: '$0.004 per worker-compute day',
	},
	durable_object_rows_read: {
		priceMicroUsd: 2_000,
		unitsPerPrice: 1_000_000,
		label: '$0.002 per million rows read',
	},
} as const satisfies Record<CreditDebitMeter, CreditDebitRate>

/**
 * Cumulative debit for `billableUnits` above the include, floored to whole
 * micro-USD. Debit lanes charge `cost(next) - cost(accounted)` so repeated
 * hourly runs never drift from the cumulative price.
 */
export function creditDebitCostMicroUsd(
	meter: CreditDebitMeter,
	billableUnits: number,
): number {
	if (!Number.isFinite(billableUnits) || billableUnits <= 0) return 0
	const rate = creditDebitRates[meter]
	const units = Math.trunc(billableUnits)
	return Math.floor((units * rate.priceMicroUsd) / rate.unitsPerPrice)
}

export const creditTopUpPackCents = [1_000, 2_500, 5_000] as const
export const creditTopUpMinCents = 500
export const creditTopUpMaxCents = 50_000

/** Low-balance notice (only while auto-refill is off) and refill floor. */
export const creditLowBalanceCents = 500
export const creditAutoRefillMinThresholdCents = 500
const creditAutoRefillMinAmountCents = creditTopUpMinCents
const creditAutoRefillMaxAmountCents = creditTopUpMaxCents
const creditAutoRefillMaxMonthlyCapCents = 200_000

/** Admin grants: positive only, bounded so a typo cannot mint a fortune. */
const creditAdminGrantMinCents = 1
export const creditAdminGrantMaxCents = 100_000
export const creditAdminGrantNoteMaxLength = 500
export const creditAdminGrantIdempotencyKeyMaxLength = 200

/**
 * House-funded welcome credits granted once per new person account at
 * signup (password, OAuth, or admin-created). Ledger id is deterministic
 * so retries never double-grant. Creation-time failures set
 * `signup_welcome_credits_pending` for a later login/wallet-touch retry.
 * Not a Stripe top-up; held until the account is credit-eligible Pro
 * (include → credits → stop).
 */
export const signupWelcomeCreditCents = 500
export const signupWelcomeCreditNote = 'Welcome credits'
export const signupWelcomeCreditLedgerIdPrefix = 'signup_welcome:'

export function signupWelcomeCreditLedgerId(stableUserId: string): string {
	return `${signupWelcomeCreditLedgerIdPrefix}${stableUserId}`
}

function isWholeCents(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value)
}

export type CreditAmountValidation =
	| { ok: true; cents: number }
	| { ok: false; error: string }

export function validateCreditTopUpCents(
	value: unknown,
): CreditAmountValidation {
	if (!isWholeCents(value)) {
		return { ok: false, error: 'Choose an amount in whole cents.' }
	}
	if (value < creditTopUpMinCents || value > creditTopUpMaxCents) {
		return {
			ok: false,
			error: `Choose between ${formatCents(creditTopUpMinCents)} and ${formatCents(creditTopUpMaxCents)}.`,
		}
	}
	return { ok: true, cents: value }
}

export function validateCreditAdminGrantCents(
	value: unknown,
): CreditAmountValidation {
	if (!isWholeCents(value)) {
		return { ok: false, error: 'Grant amount must be whole cents.' }
	}
	if (value < creditAdminGrantMinCents || value > creditAdminGrantMaxCents) {
		return {
			ok: false,
			error: `Grant between ${formatCents(creditAdminGrantMinCents)} and ${formatCents(creditAdminGrantMaxCents)}.`,
		}
	}
	return { ok: true, cents: value }
}

export type CreditAutoRefillSettings = {
	enabled: boolean
	thresholdCents: number | null
	amountCents: number | null
	monthlyCapCents: number | null
}

export const defaultCreditAutoRefillSettings: CreditAutoRefillSettings = {
	enabled: false,
	thresholdCents: null,
	amountCents: null,
	monthlyCapCents: null,
}

export type CreditNotifySettings = {
	autoRefilled: boolean
	monthlyCap: boolean
	lowBalance: boolean
}

export const defaultCreditNotifySettings: CreditNotifySettings = {
	autoRefilled: true,
	monthlyCap: true,
	lowBalance: true,
}

function readOptionalCents(value: unknown): number | null | 'invalid' {
	if (value === null || value === undefined || value === '') return null
	return isWholeCents(value) ? value : 'invalid'
}

/**
 * Validate a settings write. Turning auto-refill on requires a threshold of
 * at least $5, an amount, and a monthly cap at least that amount. Turning
 * it off keeps whatever valid numbers were sent so the form round-trips.
 */
export function validateCreditAutoRefillSettings(
	input: unknown,
):
	| { ok: true; value: CreditAutoRefillSettings }
	| { ok: false; error: string } {
	if (!input || typeof input !== 'object') {
		return { ok: false, error: 'Auto-refill settings are required.' }
	}
	const record = input as Record<string, unknown>
	if (typeof record['enabled'] !== 'boolean') {
		return { ok: false, error: 'Auto-refill must be on or off.' }
	}
	const thresholdCents = readOptionalCents(record['thresholdCents'])
	const amountCents = readOptionalCents(record['amountCents'])
	const monthlyCapCents = readOptionalCents(record['monthlyCapCents'])
	if (
		thresholdCents === 'invalid' ||
		amountCents === 'invalid' ||
		monthlyCapCents === 'invalid'
	) {
		return { ok: false, error: 'Auto-refill amounts must be whole cents.' }
	}
	const value: CreditAutoRefillSettings = {
		enabled: record['enabled'],
		thresholdCents,
		amountCents,
		monthlyCapCents,
	}
	if (!value.enabled) return { ok: true, value }
	if (
		value.thresholdCents === null ||
		value.thresholdCents < creditAutoRefillMinThresholdCents
	) {
		return {
			ok: false,
			error: `Set a refill threshold of at least ${formatCents(creditAutoRefillMinThresholdCents)}.`,
		}
	}
	if (
		value.amountCents === null ||
		value.amountCents < creditAutoRefillMinAmountCents ||
		value.amountCents > creditAutoRefillMaxAmountCents
	) {
		return {
			ok: false,
			error: `Set a refill amount between ${formatCents(creditAutoRefillMinAmountCents)} and ${formatCents(creditAutoRefillMaxAmountCents)}.`,
		}
	}
	if (
		value.monthlyCapCents === null ||
		value.monthlyCapCents < value.amountCents ||
		value.monthlyCapCents > creditAutoRefillMaxMonthlyCapCents
	) {
		return {
			ok: false,
			error: `Set a monthly cap between the refill amount and ${formatCents(creditAutoRefillMaxMonthlyCapCents)}.`,
		}
	}
	return { ok: true, value }
}

export type CreditAutoRefillDecision =
	| { action: 'charge'; amountCents: number }
	| {
			action: 'skip'
			reason:
				| 'disabled'
				| 'incomplete_settings'
				| 'above_threshold'
				| 'no_payment_method'
				| 'recent_failure'
	  }
	| { action: 'cap_reached' }

const creditAutoRefillFailureBackoffMs = 24 * 60 * 60 * 1000

/**
 * Whether the debit lane should charge an auto-refill now. Both threshold
 * and monthly cap must be set (and valid) before anything runs; a refill
 * that would push this UTC month past the cap is refused.
 */
export function decideCreditAutoRefill(input: {
	settings: CreditAutoRefillSettings
	balanceMicroUsd: number
	refilledThisMonthCents: number
	hasPaymentMethod: boolean
	lastFailedAt: string | null
	now: Date
}): CreditAutoRefillDecision {
	const { settings } = input
	if (!settings.enabled) return { action: 'skip', reason: 'disabled' }
	if (!validateCreditAutoRefillSettings(settings).ok) {
		return { action: 'skip', reason: 'incomplete_settings' }
	}
	const thresholdCents = settings.thresholdCents ?? 0
	const amountCents = settings.amountCents ?? 0
	const monthlyCapCents = settings.monthlyCapCents ?? 0
	if (input.balanceMicroUsd > thresholdCents * microUsdPerCent) {
		return { action: 'skip', reason: 'above_threshold' }
	}
	if (input.refilledThisMonthCents + amountCents > monthlyCapCents) {
		return { action: 'cap_reached' }
	}
	if (!input.hasPaymentMethod) {
		return { action: 'skip', reason: 'no_payment_method' }
	}
	const lastFailedMs = input.lastFailedAt ? Date.parse(input.lastFailedAt) : NaN
	if (
		Number.isFinite(lastFailedMs) &&
		input.now.getTime() - lastFailedMs < creditAutoRefillFailureBackoffMs
	) {
		return { action: 'skip', reason: 'recent_failure' }
	}
	return { action: 'charge', amountCents }
}

/** Crossing into the low-balance band (≤ $5) while auto-refill is off. */
export function crossedCreditLowBalance(input: {
	previousBalanceMicroUsd: number
	nextBalanceMicroUsd: number
	autoRefillEnabled: boolean
}): boolean {
	if (input.autoRefillEnabled) return false
	const threshold = creditLowBalanceCents * microUsdPerCent
	return (
		input.previousBalanceMicroUsd > threshold &&
		input.nextBalanceMicroUsd <= threshold
	)
}

export const creditLedgerEntryKinds = [
	'top_up',
	'auto_refill',
	'admin_grant',
	'debit',
] as const

export type CreditLedgerEntryKind = (typeof creditLedgerEntryKinds)[number]

export function formatCents(cents: number): string {
	const sign = cents < 0 ? '−' : ''
	const absolute = Math.abs(Math.trunc(cents))
	const dollars = Math.floor(absolute / 100)
	const remainder = String(absolute % 100).padStart(2, '0')
	return `${sign}$${dollars.toLocaleString('en-US')}.${remainder}`
}

/**
 * Balance label rounded toward zero to the cent, so a fractional-cent
 * positive balance never displays as more than the wallet holds.
 */
export function formatMicroUsd(microUsd: number): string {
	return formatCents(Math.trunc(microUsd / microUsdPerCent))
}

/**
 * Rate-card estimate label. Debit rates are sub-cent ($0.004 /
 * $0.002), so truncating to cents would render a real charge as $0.00.
 * Keeps at least two decimals; adds a third when needed.
 */
export function formatEstimatedCreditMicroUsd(microUsd: number): string {
	if (!Number.isFinite(microUsd) || microUsd === 0) return '$0.00'
	const sign = microUsd < 0 ? '−' : ''
	const dollars = Math.abs(microUsd) / 1_000_000
	const formatted = dollars.toLocaleString('en-US', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 3,
	})
	return `${sign}$${formatted}`
}
