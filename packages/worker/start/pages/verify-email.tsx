/** @jsxImportSource @emotion/react */
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildErrorAgentPrompt } from '#universal/error-agent-prompt.ts'
import { SiteLink } from '../components/site-link.tsx'
import {
	cardCss,
	getPrimaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { type EmailVerificationOutcome } from '#universal/token-outcomes.ts'

export function VerifyEmailRoute({ data }: { data: EmailVerificationOutcome }) {
	const isEmailChange = data.ok && data.kind === 'email_change'
	const isEmailClaimRelease = data.ok && data.kind === 'email_claim_release'
	const isEmailDestination = data.kind === 'email_destination'
	const title = data.ok
		? isEmailChange
			? 'Email changed'
			: isEmailClaimRelease
				? 'Email released'
				: isEmailDestination
					? 'Email destination verified'
					: 'Email verified'
		: isEmailDestination
			? 'Verify email destination'
			: 'Email verification'
	const returnsToAccount =
		isEmailChange || isEmailClaimRelease || isEmailDestination
	const ctaHref = data.ctaHref
		? data.ctaHref
		: data.ok
			? returnsToAccount
				? '/account'
				: '/onboarding'
			: isEmailDestination
				? '/account/email#email-destinations'
				: '/account'
	const ctaLabel = data.ctaLabel
		? data.ctaLabel
		: data.ok
			? returnsToAccount
				? 'Go to account'
				: 'Continue to onboarding'
			: isEmailDestination
				? 'Resend from email inbox'
				: 'Go to account'

	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>{title}</h1>
				<p css={pageDescriptionCss}>
					{data.ok
						? isEmailChange
							? 'Your Kody account uses this email address.'
							: isEmailClaimRelease
								? 'That former address can now be used to create a new Kody account.'
								: isEmailDestination
									? 'emailSend can use this address. Mail comes from your Kody platform inbox.'
									: 'Your Kody account can use MCP and send outbound email.'
						: isEmailDestination
							? 'We could not verify this email destination.'
							: 'We could not verify your email address.'}
				</p>
			</header>
			<div css={cardCss}>
				<p
					role={data.ok ? 'status' : 'alert'}
					css={{
						color: data.ok ? colors.text : colors.error,
						fontSize: typography.fontSize.base,
						margin: 0,
					}}
				>
					{data.ok ? data.message : data.error}
				</p>
				{data.ok ? null : (
					<ErrorAgentPromptButton
						prompt={buildErrorAgentPrompt({
							activity: 'Opening an email verification link.',
							errorCode: 'email_verification_failed',
							errorMessage: data.error,
							ids: { path: '/verify-email' },
							likelyCause:
								'The verification link expired, was already used, or is invalid.',
							nextSteps: [
								'Tell me how to request a new verification email.',
								'Do not ask me to paste tokens from the URL.',
							],
							kodyTools: ['search({ entity: "guide:oauth" })'],
							docs: ['search({ entity: "guide:connect_your_agent" })'],
						})}
					/>
				)}
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: spacing.md,
						flexWrap: 'wrap',
					}}
				>
					<SiteLink
						href={ctaHref}
						css={data.ok || isEmailDestination ? ctaButtonCss : mutedLinkCss}
					>
						{ctaLabel}
					</SiteLink>
					{ctaHref === '/account' ? null : (
						<SiteLink href="/account" css={mutedLinkCss}>
							Account
						</SiteLink>
					)}
				</div>
			</div>
		</section>
	)
}

const pageCss = {
	...stackedPageCss,
	maxWidth: '36rem',
	margin: '0 auto',
	gap: spacing.lg,
}

const ctaButtonCss = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	display: 'inline-flex',
	textDecoration: 'none',
}
