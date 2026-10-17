/** @jsxImportSource @emotion/react */
import { sendCancellationFeedback } from '#start/server/billing-mutations'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildBillingFailureAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { formatTimestampDate as formatCancelDate } from '../components/local-timestamp.tsx'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { orgIdentity } from '#universal/org-pages.ts'
import { SiteLink } from '../components/site-link.tsx'
import { adminGrantDiffersFromSubscription } from '#universal/account-plan-display.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import {
	type AccountBillingLoaderData,
	type AdminPlanName,
} from '#universal/loader-data.ts'
import {
	accountFieldCss,
	accountFieldLabelCss,
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	MetadataGrid,
} from './account-management-components.tsx'
import {
	type BillingInterval,
	type CheckoutPending,
	type PaidTier,
	isRetiredPaidSubscription,
	renderAccountBillingPlans,
	resolveActiveStripePlan,
} from './account-billing-plans.tsx'
import {
	billingCheckoutMutationOptions,
	billingPortalMutationOptions,
} from '../billing-checkout.ts'

import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getGhostButtonCss,
	getPillButtonCss,
	layoutMaxWidths,
	mutedLinkCss,
	primaryLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

type SubscriptionStatusTone = 'ok' | 'warn' | 'action' | 'muted'

const multipleSubscriptionsMessage =
	'You have more than one active Stripe subscription, so plan changes are handled in the Stripe portal. Opening Stripe…'

/** Stripe missing → "None"; manual/effective compatibility missing → "Free". */
function formatPlanLabel(
	plan: AdminPlanName | null,
	missingLabel: 'None' | 'Free',
) {
	if (plan == null) return missingLabel
	return plan.charAt(0).toUpperCase() + plan.slice(1)
}

function describeSubscriptionStatus(status: string): {
	label: string
	detail: string
	tone: SubscriptionStatusTone
} {
	switch (status) {
		case 'active':
			return {
				label: 'Active',
				detail: 'Your Stripe subscription is active.',
				tone: 'ok',
			}
		case 'trialing':
			return {
				label: 'Trialing',
				detail: 'You are on a Stripe trial.',
				tone: 'ok',
			}
		case 'past_due':
			return {
				label: 'Past due',
				detail:
					'Payment is past due. Your paid plan limits stay in place while Stripe retries the charge, but update your payment method in Manage subscription so the subscription does not end.',
				tone: 'action',
			}
		case 'unpaid':
			return {
				label: 'Unpaid',
				detail:
					'Stripe reports this subscription as unpaid, so paid plan limits are not active. Open Manage subscription to restore billing.',
				tone: 'action',
			}
		case 'canceled':
			return {
				label: 'Canceled',
				detail: 'This Stripe subscription is canceled.',
				tone: 'muted',
			}
		case 'incomplete':
			return {
				label: 'Incomplete',
				detail:
					'Checkout did not finish. Subscribe again or open Manage subscription if a customer already exists.',
				tone: 'warn',
			}
		case 'incomplete_expired':
			return {
				label: 'Incomplete (expired)',
				detail:
					'An incomplete checkout expired. Subscribe again to start billing.',
				tone: 'muted',
			}
		case 'paused':
			return {
				label: 'Paused',
				detail: 'This Stripe subscription is paused.',
				tone: 'warn',
			}
		default:
			return {
				label: status.replaceAll('_', ' '),
				detail: `Stripe subscription status: ${status}.`,
				tone: 'muted',
			}
	}
}

function subscriptionStatusBadgeCss(tone: SubscriptionStatusTone) {
	const accent =
		tone === 'action'
			? colors.error
			: tone === 'warn'
				? colors.primaryText
				: tone === 'ok'
					? colors.primary
					: colors.textMuted
	return {
		display: 'inline-flex',
		alignItems: 'center',
		padding: `0.2rem ${spacing.sm}`,
		borderRadius: radius.md,
		border: `1px solid ${accent}`,
		backgroundColor:
			tone === 'action'
				? 'color-mix(in srgb, var(--color-danger) 10%, var(--color-surface))'
				: colors.surface,
		color: accent,
		fontSize: typography.fontSize.xs,
		fontWeight: typography.fontWeight.semibold,
		textTransform: 'capitalize' as const,
	}
}

export function AccountBillingPage({
	payload,
	currentHref,
}: {
	payload: AccountBillingLoaderData
	currentHref: string
}) {
	const capture = useSubmitterScope()
	const [promoCode, setPromoCode] = useState('')
	const [message, setMessage] = useState<string | null>(
		payload.error ?? payload.notice ?? null,
	)
	const [messageTone, setMessageTone] = useState<'error' | 'info'>(
		payload.error ? 'error' : 'info',
	)
	const [planCheckoutError, setPlanCheckoutError] = useState<string | null>(
		null,
	)
	const orgName = orgIdentity(payload.org, {
		displayName: '',
		avatarUrl: null,
	}).name
	const portalMutation = useMutation(billingPortalMutationOptions)
	const portalPending = portalMutation.isPending
	const checkoutMutation = useMutation(billingCheckoutMutationOptions)
	const checkoutPending: CheckoutPending = checkoutMutation.isPending
		? {
				plan: checkoutMutation.variables.plan,
				interval: checkoutMutation.variables.interval,
			}
		: null
	const [cancellationFeedbackText, setCancellationFeedbackText] = useState('')
	const feedbackMutation = useMutation({
		mutationFn: (details: string) =>
			sendCancellationFeedback({ data: { details } }),
		retry: false,
		gcTime: 0,
	})
	const cancellationFeedbackPending = feedbackMutation.isPending
	const [cancellationFeedbackSent, setCancellationFeedbackSent] =
		useState(false)
	const [cancellationFeedbackError, setCancellationFeedbackError] = useState<
		string | null
	>(null)
	const [selectedIntervalByPlan, setSelectedIntervalByPlan] = useState<
		Record<PaidTier, BillingInterval>
	>({ pro: 'month' })
	function applyPayload(payload: AccountBillingLoaderData) {
		setMessage(payload.error ?? payload.notice ?? null)
		setMessageTone(payload.error ? 'error' : 'info')
	}

	async function startCheckout(
		plan: PaidTier,
		interval: BillingInterval,
		errorPlacement: 'page' | 'plan-card' = 'plan-card',
	) {
		if (checkoutPending) return
		setMessage(null)
		setPlanCheckoutError(null)
		const isCurrent = capture()
		const result = await checkoutMutation.mutateAsync({
			plan,
			orgSlug: payload.org.slug,
			interval,
			promoCode: errorPlacement === 'plan-card' ? promoCode : '',
		})
		if (!isCurrent()) return
		if (result.ok) {
			if (result.mode === 'portal') {
				// More than one active subscription: the portal update flow
				// cannot pick one, so the customer manages them in Stripe.
				setMessage(multipleSubscriptionsMessage)
				setMessageTone('info')
			}
			window.location.assign(result.url)
			return
		}
		if (errorPlacement === 'plan-card') {
			setPlanCheckoutError(result.error)
		} else {
			setMessage(result.error)
			setMessageTone('error')
		}
	}

	async function submitCancellationFeedback() {
		const sendFallback = 'Unable to send feedback. Try again shortly.'
		if (cancellationFeedbackPending) return
		const details = cancellationFeedbackText.trim()
		if (!details) {
			setCancellationFeedbackError('Share a sentence or two before sending.')
			return
		}
		const isCurrent = capture()
		setCancellationFeedbackError(null)
		try {
			await feedbackMutation.mutateAsync(details)
			if (isCurrent()) setCancellationFeedbackSent(true)
		} catch (error) {
			if (isCurrent())
				setCancellationFeedbackError(
					error instanceof Error ? error.message : sendFallback,
				)
		}
	}

	const billing = payload
	const [lastPayload, setLastPayload] = useState(payload)
	if (lastPayload !== payload) {
		setLastPayload(payload)
		applyPayload(payload)
	}

	const subscriptionStatus = billing?.subscriptionStatus?.trim() || null
	const statusInfo = subscriptionStatus
		? describeSubscriptionStatus(subscriptionStatus)
		: null
	const paymentActionNeeded =
		subscriptionStatus === 'past_due' || subscriptionStatus === 'unpaid'
	const activeStripePlan = resolveActiveStripePlan(billing)
	const retiredPlan = isRetiredPaidSubscription(billing)
	const canSwitchToPro =
		retiredPlan &&
		billing != null &&
		billing.purchasablePlans.includes('pro') &&
		!paymentActionNeeded
	const showManageCta = Boolean(
		billing?.configured && billing.hasStripeCustomer,
	)
	const planSourcesDiffer =
		billing != null &&
		adminGrantDiffersFromSubscription(billing.manualPlan, billing.stripePlan)
	const currentPlanItems = planSourcesDiffer
		? [
				{
					label: 'Granted plan',
					value: formatPlanLabel(billing.manualPlan, 'Free'),
				},
				{
					label: 'Subscription plan',
					value: formatPlanLabel(billing.stripePlan, 'None'),
				},
			]
		: []

	return (
		<AccountManagementShell
			currentHref={currentHref}
			maxWidth={layoutMaxWidths.content}
			busy={false}
		>
			<AccountPageHeader
				title="Billing"
				description={
					payload.org.personal
						? 'Your plan, Stripe subscription, and referral link.'
						: `${orgName}'s Kody plan. Pro is billed per seat: every owner and member is one.`
				}
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}

			{billing ? (
				<>
					{!billing.configured ? (
						<AccountManagementMessage tone="info">
							Billing is not configured on this deployment. Plans can still be
							granted by an administrator.
						</AccountManagementMessage>
					) : null}
					{billing.configured && !billing.hasStripeCustomer ? (
						<AccountManagementMessage tone="info">
							{billing.purchasablePlans.length > 0
								? 'No Stripe customer is linked yet. Subscribe to Pro to create one and manage billing in Stripe.'
								: 'No paid tier is configured for checkout on this deployment.'}
						</AccountManagementMessage>
					) : null}
					{billing.configured && billing.hasStripeCustomer ? (
						<p css={descriptionCss}>
							Stripe customer linked. Use Manage subscription for payment
							methods, invoices, and cancellation.
						</p>
					) : null}
					{statusInfo?.tone === 'action' ? (
						<>
							<AccountManagementMessage tone="error">
								{statusInfo.detail}
							</AccountManagementMessage>
							<ErrorAgentPromptButton
								prompt={buildBillingFailureAgentPrompt({
									kind:
										subscriptionStatus === 'past_due'
											? 'past_due'
											: 'payment_failed',
									errorMessage: statusInfo.detail,
									orgSlug: payload.org.slug,
									path: currentHref,
								})}
							/>
						</>
					) : null}

					<AccountManagementPanel title="Current plan">
						<div
							css={{
								display: 'flex',
								flexWrap: 'wrap',
								alignItems: 'baseline',
								gap: `${spacing.sm} ${spacing.md}`,
							}}
						>
							<p
								css={{
									margin: 0,
									fontSize: typography.fontSize.lg,
									fontWeight: typography.fontWeight.semibold,
									color: colors.text,
								}}
							>
								{formatPlanLabel(billing.effectivePlan, 'Free')}
							</p>
							{statusInfo ? (
								<span css={subscriptionStatusBadgeCss(statusInfo.tone)}>
									{statusInfo.label}
								</span>
							) : null}
							<SiteLink
								href={billing.usageHref ?? `/@${billing.org.slug}`}
								css={mutedLinkCss}
							>
								view usage
							</SiteLink>
						</div>
						{statusInfo && statusInfo.tone !== 'action' ? (
							<p css={descriptionCss}>{statusInfo.detail}</p>
						) : null}
						{currentPlanItems.length > 0 ? (
							<>
								<p css={descriptionCss}>
									Your effective plan is the higher of any admin grant and your
									Stripe subscription.
								</p>
								<MetadataGrid items={currentPlanItems} />
							</>
						) : null}
						{billing.cancelAt ? (
							<p css={descriptionCss}>
								Your subscription is scheduled to cancel on{' '}
								{formatCancelDate(billing.cancelAt)}.
							</p>
						) : null}
						{billing.creditsEligible && billing.creditsHref ? (
							<p css={{ margin: 0 }}>
								<SiteLink href={billing.creditsHref} css={primaryLinkCss}>
									Manage credits
								</SiteLink>
							</p>
						) : null}
						{retiredPlan ? (
							<>
								<p css={descriptionCss}>Credits are available on Pro.</p>
								{canSwitchToPro ? (
									<div>
										<button
											type="button"
											disabled={checkoutPending !== null}
											onClick={() =>
												void startCheckout(
													'pro',
													billing.stripeInterval ?? 'month',
													'page',
												)
											}
											css={primaryButtonCss}
										>
											{checkoutPending ? 'Opening Stripe…' : 'Switch to Pro'}
										</button>
									</div>
								) : null}
							</>
						) : null}
					</AccountManagementPanel>

					{billing.referralProgram ? (
						<AccountManagementPanel
							title="Refer a friend"
							description="Share your link. When someone new creates an account, verifies their email, and pays their first invoice, you both get one month of Pro. There is no cap."
						>
							<div
								css={{
									display: 'grid',
									gap: spacing.sm,
								}}
							>
								<div css={accountFieldCss}>
									<label
										htmlFor="referral-share-url"
										css={accountFieldLabelCss}
									>
										Your referral link
									</label>
									<div
										css={{
											display: 'flex',
											flexWrap: 'wrap',
											gap: spacing.sm,
											alignItems: 'center',
										}}
									>
										<input
											id="referral-share-url"
											type="url"
											readOnly
											value={billing.referralProgram.shareUrl}
											data-field-ring
											css={{
												...accountInputCss,
												flex: '1 1 16rem',
											}}
										/>
										<CopyTextButton
											value={billing.referralProgram.shareUrl}
											idleLabel="Copy link"
											variant="ghost"
											size="sm"
											ariaLabel="Copy referral link"
										/>
									</div>
								</div>
								<MetadataGrid
									items={[
										{
											label: 'Rewarded',
											value: String(billing.referralProgram.rewardedCount),
										},
										{
											label: 'Pending first payment',
											value: String(billing.referralProgram.pendingCount),
										},
										{
											label: 'Pro credit through',
											value: billing.referralProgram.creditExpiresAt
												? formatCancelDate(
														billing.referralProgram.creditExpiresAt,
													)
												: 'None yet',
										},
									]}
								/>
								{billing.referralProgram.referrals.length > 0 ? (
									<ul
										css={{
											margin: 0,
											padding: 0,
											listStyle: 'none',
											display: 'grid',
											gap: spacing.xs,
										}}
									>
										{billing.referralProgram.referrals.map((item) => (
											<li
												key={`${item.createdAt}:${item.refereeUsername ?? 'unknown'}`}
												css={descriptionCss}
											>
												{item.refereeUsername
													? `@${item.refereeUsername}`
													: 'A referred account'}{' '}
												{item.status === 'rewarded' ? (
													item.rewardedAt ? (
														<>
															earned you a month on{' '}
															{formatCancelDate(item.rewardedAt)}
														</>
													) : (
														'earned you a month'
													)
												) : (
													'signed up and has not paid yet'
												)}
											</li>
										))}
									</ul>
								) : (
									<p css={descriptionCss}>No one has used your link yet.</p>
								)}
							</div>
						</AccountManagementPanel>
					) : null}

					{billing.cancelAt ? (
						<AccountManagementPanel
							title="Before you go"
							description="What led you to cancel? A sentence or two goes straight to the operator and shapes what gets fixed."
						>
							{cancellationFeedbackSent ? (
								<p css={descriptionCss}>
									Thank you — your feedback is on its way.
								</p>
							) : (
								<div css={{ display: 'grid', gap: spacing.sm }}>
									<label css={{ display: 'grid', gap: spacing.xs }}>
										<span css={visuallyHiddenCss}>Cancellation feedback</span>
										<textarea
											rows={3}
											maxLength={8000}
											placeholder="Too expensive, missing a feature, not useful enough…"
											value={cancellationFeedbackText}
											onInput={(event) => {
												setCancellationFeedbackText(
													(event.currentTarget as HTMLTextAreaElement).value,
												)
											}}
											css={{
												padding: spacing.sm,
												borderRadius: radius.md,
												border: `1px solid ${colors.border}`,
												backgroundColor: colors.background,
												color: colors.text,
												fontFamily: 'inherit',
												fontSize: typography.fontSize.sm,
												resize: 'vertical' as const,
											}}
										/>
									</label>
									{cancellationFeedbackError ? (
										<AccountManagementMessage tone="error">
											{cancellationFeedbackError}
										</AccountManagementMessage>
									) : null}
									<div>
										<button
											type="button"
											disabled={cancellationFeedbackPending}
											onClick={() => void submitCancellationFeedback()}
											css={secondaryButtonCss}
										>
											{cancellationFeedbackPending
												? 'Sending…'
												: 'Send feedback'}
										</button>
									</div>
								</div>
							)}
						</AccountManagementPanel>
					) : null}

					{showManageCta ? (
						<AccountManagementPanel
							title="Actions"
							description="Open the Stripe portal for payment methods, invoices, and cancellation."
						>
							<div
								css={{
									display: 'flex',
									flexWrap: 'wrap',
									gap: spacing.sm,
									alignItems: 'center',
								}}
							>
								<button
									type="button"
									disabled={portalPending}
									onClick={async () => {
										if (portalPending) return
										const isCurrent = capture()
										try {
											const result = await portalMutation.mutateAsync(
												payload.org.slug,
											)
											if (isCurrent()) window.location.assign(result.url)
										} catch (error) {
											if (!isCurrent()) return
											setMessage(
												error instanceof Error
													? error.message
													: 'Unable to open billing portal.',
											)
											setMessageTone('error')
										}
									}}
									css={{
										...(statusInfo?.tone === 'action'
											? primaryButtonCss
											: secondaryButtonCss),
										display: 'inline-block',
										textDecoration: 'none',
										textAlign: 'center',
									}}
								>
									Manage subscription
								</button>
							</div>
						</AccountManagementPanel>
					) : null}
					{renderAccountBillingPlans({
						promoCode,
						checkoutError: planCheckoutError,
						onPromoCodeChange: (value) => {
							setPromoCode(value)
							setPlanCheckoutError(null)
						},
						billing,
						activeStripePlan,
						paymentActionNeeded,
						checkoutPending,
						selectedIntervalByPlan,
						onIntervalChange: (plan, interval) => {
							setPlanCheckoutError(null)
							setSelectedIntervalByPlan((previous) => ({
								...previous,
								[plan]: interval,
							}))
						},
						onStartCheckout: (plan, interval) =>
							void startCheckout(plan, interval),
					})}
				</>
			) : null}

			<p css={{ margin: 0 }}>
				<SiteLink
					href={payload.org.personal ? '/account' : `/@${payload.org.slug}`}
					css={primaryLinkCss}
				>
					{payload.org.personal ? 'Back to account' : `Back to ${orgName}`}
				</SiteLink>
			</p>
		</AccountManagementShell>
	)
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
