import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import {
	type AccountCreditsDebitMeter,
	type AccountCreditsLimit,
	type AccountUsageComputeOverage,
	type AccountUsageCredits,
} from '#universal/loader-data.ts'
import {
	creditAutoRefillMinThresholdCents,
	creditDebitCostMicroUsd,
	creditDebitRates,
	creditTopUpMaxCents,
	creditTopUpMinCents,
	creditTopUpPackCents,
} from '#universal/credits.ts'
import { isCustomerFacingComputeMeter } from '#universal/compute-overage.ts'
import { type CreditsAlarmAutoRefill } from '#universal/usage-presentation.ts'
import {
	creditsUnlockedResources,
	entitlementResourceLabels,
	resolvePlanLimit,
	resolveWeeklyPlanLimit,
	weeklyEntitlementResourceLabel,
	isWeeklyComputeWindowResource,
	type UserEntitlement,
} from '#universal/plans.ts'
import {
	getPurchasablePlans,
	isBillingConfigured,
} from '#worker/billing/billing-config.ts'
import {
	listCreditLedgerEntries,
	readCreditWallet,
	sumCreditAutoRefillCents,
	toAccountCreditsLedgerItem,
	type CreditWallet,
} from '#worker/billing/credit-wallet.ts'
import {
	isPayingForCreditsPro,
	resolveUserEntitlementFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const recentLedgerLimit = 10

/**
 * The org's Pro include (pooled across `seats`) and how far credits can
 * carry usage past it, for the rate limits credits apply to. Numbers only,
 * framed as a ceiling on credits (not a tier a balance unlocks). Stock is on
 * the Pro subscription, not listed.
 */
export function listCreditsCeilingLimits(
	seats = 1,
): Array<AccountCreditsLimit> {
	const limits: Array<AccountCreditsLimit> = []
	for (const resource of creditsUnlockedResources) {
		limits.push({
			resource,
			label: entitlementResourceLabels[resource],
			included: resolvePlanLimit('pro', resource, 'public', 'empty', seats),
			creditsCeiling: resolvePlanLimit(
				'pro',
				resource,
				'public',
				'funded',
				seats,
			),
		})
		if (!isWeeklyComputeWindowResource(resource)) continue
		const included = resolveWeeklyPlanLimit(
			'pro',
			resource,
			'public',
			'empty',
			seats,
		)
		const creditsCeiling = resolveWeeklyPlanLimit(
			'pro',
			resource,
			'public',
			'funded',
			seats,
		)
		if (included === null || creditsCeiling === null) continue
		limits.push({
			resource: `${resource}:week`,
			label: weeklyEntitlementResourceLabel(resource),
			included,
			creditsCeiling,
		})
	}
	return limits
}

export type AccountCreditsUser = {
	id: number
	stableUserId: string
	stripeCustomerId: string | null
	entitlement: UserEntitlement
	/** Paying for the purchasable Pro: may buy credits and auto-refill. */
	canBuyCredits: boolean
}

/** Paying for the purchasable Pro with a Stripe customer and a wallet. */
export function canBuyCreditsForUser(input: {
	row: UserEntitlementRow
	entitlement: UserEntitlement
	stripeCustomerId: string | null
}): boolean {
	return (
		input.entitlement.creditWallet !== 'none' &&
		isPayingForCreditsPro(input.row) &&
		input.stripeCustomerId !== null
	)
}

/**
 * Credits buyer for one organization. Personal orgs keep the users⋈orgs
 * join; team orgs read plan/customer columns from `orgs` and use that org's
 * id as the wallet key (same `user_id` column as metering).
 */
export async function loadAccountCreditsUser(input: {
	env: Env
	userId: number
	/** Organization whose wallet and Stripe customer this mutates. */
	orgId: string
	/** When true, `orgId` is the signed-in person's signup organization. */
	personal: boolean
	now?: Date
}): Promise<AccountCreditsUser | null> {
	if (input.personal) {
		const row = await input.env.APP_DB.prepare(
			`SELECT u.id, u.stable_user_id, o.stripe_customer_id, ${userEntitlementColumnsSql('o')}
			 FROM users u
			 INNER JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)
			 WHERE u.id = ?${andLiveDeletedAtSql('u')}${andLiveDeletedAtSql('o')}`,
		)
			.bind(input.userId)
			.first<
				UserEntitlementRow & {
					id: number
					stable_user_id: string
					stripe_customer_id: string | null
				}
			>()
		if (!row) return null
		const entitlement = await resolveUserEntitlementFromRow({
			db: input.env.APP_DB,
			stableUserId: row.stable_user_id,
			row,
			now: input.now,
		})
		const stripeCustomerId = row.stripe_customer_id?.trim() || null
		return {
			id: row.id,
			stableUserId: row.stable_user_id,
			stripeCustomerId,
			entitlement,
			canBuyCredits: canBuyCreditsForUser({
				row,
				entitlement,
				stripeCustomerId,
			}),
		}
	}
	const row = await input.env.APP_DB.prepare(
		`SELECT stripe_customer_id, ${userEntitlementColumnsSql()}
		 FROM orgs
		 WHERE id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.orgId)
		.first<UserEntitlementRow & { stripe_customer_id: string | null }>()
	if (!row) return null
	const entitlement = await resolveUserEntitlementFromRow({
		db: input.env.APP_DB,
		stableUserId: input.orgId,
		row,
		now: input.now,
	})
	const stripeCustomerId = row.stripe_customer_id?.trim() || null
	return {
		id: input.userId,
		stableUserId: input.orgId,
		stripeCustomerId,
		entitlement,
		canBuyCredits: canBuyCreditsForUser({ row, entitlement, stripeCustomerId }),
	}
}

/**
 * The Credits section of `/account/usage`, plus the wallet read the usage
 * story's alarm needs so the page reads the wallet once. Operator plans get
 * no section; accounts without a wallet get only the switch-to-Pro prompt.
 * Pass {@link wallet} when `/account/usage` already loaded it for entitlement
 * resolution so the page does not query `credit_wallets` again.
 */
export async function loadAccountUsageCredits(input: {
	env: Env
	stableUserId: string
	entitlement: UserEntitlement
	/** {@link canBuyCreditsForUser}; billing configuration is checked here. */
	canBuyCredits: boolean
	/** {@link isPayingForCreditsPro}; independent of Stripe customer id. */
	hasPaidProSubscription: boolean
	computeOverage: AccountUsageComputeOverage | null
	now: Date
	/** When set, skip the credit_wallets read. */
	wallet?: CreditWallet
	/** Signup organization billing page. Required for the switch-to-Pro link. */
	billingHref: string
}): Promise<{
	credits: AccountUsageCredits | null
	wallet: {
		balanceMicroUsd: number
		autoRefill: CreditsAlarmAutoRefill
	} | null
}> {
	if (input.entitlement.plan === 'max') return { credits: null, wallet: null }
	const configured = isBillingConfigured(input.env)
	const canSwitchToPro =
		configured && getPurchasablePlans(input.env).includes('pro')
	if (input.entitlement.creditWallet === 'none') {
		return {
			credits: {
				eligible: false,
				canSwitchToPro,
				billingHref: input.billingHref,
			},
			wallet: null,
		}
	}
	const db = input.env.APP_DB
	const [wallet, refilledThisMonthCents, recent] = await Promise.all([
		input.wallet
			? Promise.resolve(input.wallet)
			: readCreditWallet(db, input.stableUserId),
		sumCreditAutoRefillCents({
			db,
			userId: input.stableUserId,
			month: utcMonthKey(input.now),
		}),
		listCreditLedgerEntries({
			db,
			userId: input.stableUserId,
			limit: recentLedgerLimit,
		}),
	])
	return {
		credits: {
			eligible: true,
			configured,
			canSwitchToPro,
			canBuyCredits: configured && input.canBuyCredits,
			hasPaidProSubscription: input.hasPaidProSubscription,
			balanceMicroUsd: wallet.balanceMicroUsd,
			hasCredits: input.entitlement.creditWallet === 'funded',
			packsCents: [...creditTopUpPackCents],
			customMinCents: creditTopUpMinCents,
			customMaxCents: creditTopUpMaxCents,
			autoRefill: {
				...wallet.autoRefill,
				minThresholdCents: creditAutoRefillMinThresholdCents,
				refilledThisMonthCents,
				hasPaymentMethod: Boolean(wallet.autoRefillPaymentMethodId),
			},
			notify: wallet.notify,
			limits: listCreditsCeilingLimits(input.entitlement.seats),
			debitMeters: input.computeOverage
				? toCreditsDebitMeters(input.computeOverage.meters)
				: [],
			recent: recent.map(toAccountCreditsLedgerItem),
		},
		wallet: {
			balanceMicroUsd: wallet.balanceMicroUsd,
			autoRefill: { ...wallet.autoRefill, refilledThisMonthCents },
		},
	}
}

/**
 * Rate-card rows for the Credits section. Reuses the same meters as included
 * compute — never invent a second path or a CPU debit.
 */
export function toCreditsDebitMeters(
	meters: Array<{
		resource: string
		label: string
		current: number
		include: number
		percentOfLimit: number
	}>,
): Array<AccountCreditsDebitMeter> {
	const rows: Array<AccountCreditsDebitMeter> = []
	for (const meter of meters) {
		if (!isCustomerFacingComputeMeter(meter.resource)) continue
		const pastInclude = Math.max(0, meter.current - meter.include)
		rows.push({
			meter: meter.resource,
			label: meter.label,
			unitRateLabel: creditDebitRates[meter.resource].label,
			include: meter.include,
			used: meter.current,
			pastInclude,
			percentOfInclude: meter.percentOfLimit,
			estCreditsMicroUsd: creditDebitCostMicroUsd(meter.resource, pastInclude),
		})
	}
	return rows
}
