/** @jsxImportSource @emotion/react */
import { useServerFn } from '@tanstack/react-start'
import { resendWebsiteVerification } from '#start/server/auth-mutations'
import {
	describeEmailVerificationDelivery,
	type EmailVerificationDelivery,
	type EmailVerificationDeliveryIndicator,
} from '#universal/email-verification-delivery.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'

export { buildPendingVerificationPath } from '#client/routes/pending-verification-path.ts'

export type ResendVerificationResult =
	| { ok: true; message: string }
	| { ok: false; message: string }

export async function requestResendVerification(
	redirectTo?: string | null,
): Promise<ResendVerificationResult> {
	const safeRedirectTo = normalizeRedirectTo(redirectTo)
	const payload = await resendWebsiteVerification({
		data: safeRedirectTo ? { redirectTo: safeRedirectTo } : {},
	})
	if (!payload.successful || !payload.ok) {
		return {
			ok: false,
			message:
				typeof payload?.error === 'string'
					? payload.error
					: 'Unable to resend the verification email.',
		}
	}
	return {
		ok: true,
		message:
			typeof payload.message === 'string'
				? payload.message
				: 'Verification email sent. Check your inbox.',
	}
}

/** Direct event callers need native redirect handling outside Query. */
export function useResendVerification(): (
	redirectTo?: string | null,
) => Promise<ResendVerificationResult | undefined> {
	return useServerFn(requestResendVerification)
}

type EmailVerificationPromptOptions = {
	email?: string | null
	title?: string
	description: string
	delivery?: EmailVerificationDelivery | null
	resendStatus: 'idle' | 'sending'
	resendMessage: string | null
	resendTone?: 'error' | 'info'
	onResend: () => void
	continueLabel?: string | null
	onContinue?: (() => void) | null
	secondaryHref?: string | null
	secondaryLabel?: string | null
}

function renderDeliveryIndicator(
	indicator: EmailVerificationDeliveryIndicator,
) {
	const label =
		indicator === 'waiting'
			? 'Waiting for delivery confirmation'
			: indicator === 'delivered'
				? 'Delivered to mailbox'
				: indicator === 'delayed'
					? 'Delivery delayed'
					: 'Delivery failed'
	const iconColor =
		indicator === 'failed'
			? colors.danger
			: indicator === 'delayed'
				? colors.warningText
				: colors.primary
	return (
		<p
			role="status"
			data-testid="email-verification-delivery-indicator"
			data-indicator={indicator}
			css={{
				display: 'flex',
				alignItems: 'center',
				gap: spacing.sm,
				margin: 0,
				color: iconColor,
				fontSize: '0.95rem',
			}}
		>
			<span
				aria-hidden="true"
				css={
					indicator === 'waiting'
						? deliverySpinnerCss
						: {
								display: 'inline-flex',
								alignItems: 'center',
								justifyContent: 'center',
								width: '1.1rem',
								height: '1.1rem',
								fontWeight: 700,
								lineHeight: 1,
							}
				}
			>
				{indicator === 'waiting'
					? null
					: indicator === 'delivered'
						? '✓'
						: indicator === 'delayed'
							? '…'
							: '!'}
			</span>
			<span>{label}</span>
		</p>
	)
}

/**
 * Shared verify-email callout used by pending signup, account, and the MCP
 * authorize gate. Keeps resend/continue actions consistent.
 */
export function renderEmailVerificationPrompt(
	options: EmailVerificationPromptOptions,
) {
	const title = options.title ?? 'Verify your email'
	const delivery = describeEmailVerificationDelivery(options.delivery ?? null)
	const promptTitle = delivery.headline ?? title
	const promptDescription = delivery.detail ?? options.description
	const canResend = delivery.canResend
	const primaryButtonCss = getPrimaryButtonCss({
		size: 'md',
		weight: 'semibold',
	})
	const secondaryButtonCss = getSecondaryButtonCss({
		size: 'md',
		weight: 'semibold',
	})

	return (
		<section
			aria-label="Email verification status"
			css={{
				...cardCss,
				borderColor: delivery.tone === 'error' ? colors.danger : colors.primary,
				backgroundColor:
					delivery.tone === 'error'
						? 'color-mix(in srgb, var(--color-danger) 6%, transparent)'
						: colors.primarySoftest,
			}}
		>
			<h2 css={cardTitleCss}>{promptTitle}</h2>
			{renderDeliveryIndicator(delivery.indicator)}
			<p css={descriptionCss}>{promptDescription}</p>
			{delivery.helpHref && delivery.helpLabel ? (
				<p css={{ ...descriptionCss, margin: 0 }}>
					<SiteLink href={delivery.helpHref} css={mutedLinkCss}>
						{delivery.helpLabel}
					</SiteLink>
				</p>
			) : null}
			{options.email ? (
				<p css={{ ...descriptionCss, margin: 0 }}>
					Sent to <strong>{options.email}</strong>
				</p>
			) : null}
			<div
				css={{
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
					alignItems: 'center',
				}}
			>
				<button
					type="button"
					disabled={!canResend || options.resendStatus === 'sending'}
					css={primaryButtonCss}
					onClick={options.onResend}
				>
					{options.resendStatus === 'sending'
						? 'Sending...'
						: canResend
							? 'Resend verification email'
							: 'Resend unavailable'}
				</button>
				{options.continueLabel && options.onContinue ? (
					<button
						type="button"
						css={secondaryButtonCss}
						onClick={options.onContinue}
					>
						{options.continueLabel}
					</button>
				) : null}
				{options.secondaryHref && options.secondaryLabel ? (
					<SiteLink href={options.secondaryHref} css={mutedLinkCss}>
						{options.secondaryLabel}
					</SiteLink>
				) : null}
			</div>
			{options.resendMessage ? (
				<p
					role="status"
					css={{
						color: options.resendTone === 'error' ? colors.error : colors.text,
						margin: 0,
					}}
				>
					{options.resendMessage}
				</p>
			) : null}
		</section>
	)
}

const deliverySpinnerCss = {
	display: 'inline-block',
	width: '1.1rem',
	height: '1.1rem',
	borderRadius: '999px',
	border: `2px solid color-mix(in srgb, ${colors.primary} 30%, transparent)`,
	borderTopColor: colors.primary,
	animation: 'kody-email-delivery-spin 0.8s linear infinite',
	'@keyframes kody-email-delivery-spin': {
		to: { transform: 'rotate(360deg)' },
	},
}
