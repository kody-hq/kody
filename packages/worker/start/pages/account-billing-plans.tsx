/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import {
	type AccountBillingLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import {
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'
import { type BillingInterval } from '../billing-checkout.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	primaryLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
export type PaidTier = 'pro'
type PlanTier = 'free' | PaidTier
export type { BillingInterval }
export type CheckoutPending = {
	plan: PaidTier
	interval: BillingInterval
} | null
/** Stripe subscription tiers, including retired Standard and $49 Pro. */
export type StripePaidPlan = 'standard' | 'pro'
const proratedSwitchNote =
	'Switching plans is prorated: Stripe shows the exact charge or credit and asks you to confirm before anything changes.'
function describePlanSwitch(input: {
	interval: BillingInterval
	onPurchasablePro: boolean
}) {
	if (input.onPurchasablePro) {
		return input.interval === 'year'
			? 'Switch to annual (prorated)'
			: 'Switch to monthly (prorated)'
	}
	return 'Switch to Pro (prorated)'
}
const planTiers: Array<{
	id: PlanTier
	name: string
	price: string
	annualPrice?: string
	description: string
}> = [
	{
		id: 'free',
		name: 'Free',
		price: '$0',
		description:
			'Room to build real automations. Capped on daily volume, not on how much you build.',
	},
	{
		id: 'pro',
		name: 'Pro',
		price: '$12/month',
		annualPrice: '$120/year',
		description:
			'More room for jobs, workflows, and daily volume, with a monthly include. Need more? Add prepaid credits.',
	},
]
/** Mirrors server rank: free < standard < pro < max. */
function getPlanRank(plan: AdminPlanName): number {
	switch (plan) {
		case 'free':
			return 0
		case 'standard':
			return 1
		case 'pro':
			return 2
		case 'max':
			return 3
		default: {
			const exhaustive: never = plan
			throw new Error(`Unknown plan: ${String(exhaustive)}`)
		}
	}
}
function planCoversTier(effectivePlan: AdminPlanName, tier: PlanTier): boolean {
	return getPlanRank(effectivePlan) >= getPlanRank(tier)
}
/**
 * The tier the customer's Stripe subscription is on. Their plan changes are
 * prorated updates to that subscription (confirmed in the portal), not new
 * checkouts, so the buttons say "Switch" instead of "Subscribe".
 */
export function resolveActiveStripePlan(
	billing: AccountBillingLoaderData | null,
): StripePaidPlan | null {
	return billing?.hasStripeCustomer &&
		(billing.stripePlan === 'standard' || billing.stripePlan === 'pro')
		? billing.stripePlan
		: null
}
/**
 * Subscribed to retired Standard or $49 Pro: kept as-is, no credit wallet,
 * and offered a prorated switch to the purchasable Pro.
 */
export function isRetiredPaidSubscription(
	billing: AccountBillingLoaderData | null,
): boolean {
	const active = resolveActiveStripePlan(billing)
	if (!billing || active === null) return false
	return active === 'standard' || !billing.creditsEligible
}
/** "3 seats · $36/month" for organizations with more than the signup seat. */
function describeSeatPricing(seats: number, interval: BillingInterval) {
	const label = seats === 1 ? '1 seat' : `${seats} seats`
	return interval === 'year'
		? `${label} · $${120 * seats}/year`
		: `${label} · $${12 * seats}/month`
}
export function renderAccountBillingPlans(input: {
	billing: AccountBillingLoaderData
	activeStripePlan: StripePaidPlan | null
	paymentActionNeeded: boolean
	checkoutPending: CheckoutPending
	selectedIntervalByPlan: Record<PaidTier, BillingInterval>
	promoCode: string
	checkoutError: string | null
	onIntervalChange: (plan: PaidTier, interval: BillingInterval) => void
	onPromoCodeChange: (value: string) => void
	onStartCheckout: (plan: PaidTier, interval: BillingInterval) => void
}) {
	const {
		billing,
		activeStripePlan,
		paymentActionNeeded,
		checkoutPending,
		selectedIntervalByPlan,
	} = input
	const retired = isRetiredPaidSubscription(billing)
	const { personal, seats } = billing.org
	return (
		<AccountManagementPanel title="Plans">
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					gap: spacing.md,
					[mq.mobile]: {
						gridTemplateColumns: '1fr',
					},
				}}
			>
				{planTiers.map((tier) => {
					const paidTier: PaidTier | null = tier.id === 'free' ? null : tier.id
					// Retired Standard/Pro subscribers are not on the Pro sold
					// here, so the Pro card offers the switch instead of
					// reading "Current plan".
					const isCurrent =
						billing.effectivePlan === tier.id && !(paidTier && retired)
					const isIncluded =
						!isCurrent &&
						!(paidTier && retired) &&
						planCoversTier(billing.effectivePlan, tier.id)
					const purchasable =
						paidTier != null &&
						billing.purchasablePlans.includes(paidTier) &&
						!paymentActionNeeded
					const showSubscribe = purchasable && !isCurrent && !isIncluded
					// On the purchasable Pro: offer the other billing interval
					// when the current one is known.
					const intervalSwitch: BillingInterval | null =
						purchasable &&
						billing.creditsEligible &&
						billing.stripeInterval != null
							? billing.stripeInterval === 'month'
								? 'year'
								: 'month'
							: null
					return (
						<div
							key={tier.id}
							css={{
								display: 'grid',
								gap: spacing.sm,
								alignContent: 'start',
								padding: spacing.md,
								borderRadius: radius.md,
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.background,
							}}
						>
							<strong
								css={{
									fontSize: typography.fontSize.base,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								{tier.name}
							</strong>
							<span
								css={{
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								{tier.price}
							</span>
							{tier.annualPrice ? (
								<span
									css={{
										fontSize: typography.fontSize.sm,
										color: colors.textMuted,
									}}
								>
									{tier.annualPrice}
								</span>
							) : null}
							<p css={descriptionCss}>{tier.description}</p>
							{paidTier && !personal ? (
								<p
									css={{ margin: 0, color: colors.text }}
									data-testid="billing-seat-pricing"
								>
									{describeSeatPricing(
										seats,
										activeStripePlan && billing.stripeInterval
											? billing.stripeInterval
											: selectedIntervalByPlan[paidTier],
									)}
								</p>
							) : null}
							{billing.usageHref ? (
								<p css={{ margin: 0 }}>
									<SiteLink href={billing.usageHref} css={primaryLinkCss}>
										See your current usage
									</SiteLink>
								</p>
							) : null}
							{intervalSwitch && paidTier ? (
								<div
									css={{
										display: 'flex',
										flexWrap: 'wrap',
										gap: spacing.sm,
									}}
								>
									<button type="button" disabled css={secondaryButtonCss}>
										{isCurrent ? 'Current plan' : 'Your subscription'}
									</button>
									<button
										type="button"
										disabled={checkoutPending !== null}
										onClick={() =>
											input.onStartCheckout(paidTier, intervalSwitch)
										}
										css={primaryButtonCss}
									>
										{checkoutPending?.plan === paidTier
											? 'Opening Stripe…'
											: describePlanSwitch({
													interval: intervalSwitch,
													onPurchasablePro: true,
												})}
									</button>
								</div>
							) : isCurrent || isIncluded ? (
								<div>
									<button type="button" disabled css={secondaryButtonCss}>
										{isCurrent ? 'Current plan' : 'Included in your plan'}
									</button>
								</div>
							) : showSubscribe && paidTier ? (
								<div
									css={{
										display: 'grid',
										gap: spacing.sm,
									}}
								>
									<fieldset
										css={{
											margin: 0,
											padding: 0,
											border: 'none',
											display: 'grid',
											gap: spacing.xs,
										}}
									>
										<legend css={visuallyHiddenCss}>
											{tier.name} billing interval
										</legend>
										<label
											css={{
												display: 'flex',
												gap: spacing.sm,
												alignItems: 'center',
											}}
										>
											<input
												type="radio"
												name={`${paidTier}-interval`}
												checked={selectedIntervalByPlan[paidTier] === 'month'}
												onChange={() =>
													input.onIntervalChange(paidTier, 'month')
												}
											/>
											<span>Monthly</span>
										</label>
										<label
											css={{
												display: 'flex',
												gap: spacing.sm,
												alignItems: 'center',
											}}
										>
											<input
												type="radio"
												name={`${paidTier}-interval`}
												checked={selectedIntervalByPlan[paidTier] === 'year'}
												onChange={() =>
													input.onIntervalChange(paidTier, 'year')
												}
											/>
											<span>Annual</span>
										</label>
									</fieldset>
									{activeStripePlan ? null : (
										<label css={{ display: 'grid', gap: spacing.xs }}>
											<span
												css={{
													fontSize: typography.fontSize.sm,
													color: colors.text,
												}}
											>
												Promo code (optional)
											</span>
											<input
												type="text"
												name="promo-code"
												autoComplete="off"
												spellCheck={false}
												maxLength={64}
												value={input.promoCode}
												data-field-ring
												css={promoInputCss}
												onChange={(event) =>
													input.onPromoCodeChange(event.currentTarget.value)
												}
											/>
											<span css={descriptionCss}>
												Promo codes apply to monthly billing.
											</span>
										</label>
									)}
									<div>
										<button
											type="button"
											disabled={checkoutPending !== null}
											onClick={() =>
												input.onStartCheckout(
													paidTier,
													selectedIntervalByPlan[paidTier],
												)
											}
											css={primaryButtonCss}
										>
											{checkoutPending?.plan === paidTier
												? activeStripePlan
													? 'Opening Stripe…'
													: 'Starting checkout…'
												: activeStripePlan
													? describePlanSwitch({
															interval: selectedIntervalByPlan[paidTier],
															onPurchasablePro: false,
														})
													: selectedIntervalByPlan[paidTier] === 'year'
														? 'Subscribe annually'
														: 'Subscribe monthly'}
										</button>
									</div>
									{input.checkoutError ? (
										<AccountManagementMessage tone="error">
											{input.checkoutError}
										</AccountManagementMessage>
									) : null}
								</div>
							) : null}
						</div>
					)
				})}
			</div>
			{activeStripePlan && !paymentActionNeeded ? (
				<p css={descriptionCss}>{proratedSwitchNote}</p>
			) : null}
		</AccountManagementPanel>
	)
}
const promoInputCss = { ...accountInputCss, maxWidth: '16rem' }
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
