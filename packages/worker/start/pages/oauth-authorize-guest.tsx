/** @jsxImportSource @emotion/react */
import {
	descriptionCss,
	getPrimaryButtonCss,
	getSecondaryButtonCss,
	pageEyebrowCss,
	pageTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { renderIcon } from '../components/icon.tsx'
import { KodyMark } from '../components/kody-mark.tsx'
import { SiteLink } from '../components/site-link.tsx'

export type GuestConnection = {
	redirectTo: string
	claimUrl: string
	expiresAt: string
}

/** `Nov 4, 11:24 PM MT` in Kody's home time zone. */
export function formatGuestDeadline(iso: string) {
	const formatted = new Intl.DateTimeFormat('en-US', {
		timeZone: 'America/Denver',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(new Date(iso))
	return `${formatted} MT`
}

export function displayClaimUrl(url: string) {
	return url.replace(/^https?:\/\//, '')
}

export function OAuthAuthorizeConnectionHeader(props: {
	clientLabel: string
	heading?: string
}) {
	const initial = props.clientLabel.trim().charAt(0).toUpperCase() || '?'
	return (
		<header css={headerCss}>
			<div css={iconRowCss} data-testid="oauth-authorize-icons">
				<span css={clientIconCss} aria-hidden="true">
					{initial}
				</span>
				<span css={linkGlyphCss} aria-hidden="true">
					{renderIcon('link', { size: '1.1rem' })}
				</span>
				<SiteLink href="/" css={kodyIconCss} aria-label="Kody home">
					<KodyMark size={30} title="" />
				</SiteLink>
			</div>
			<span css={pageEyebrowCss}>Kody secure connection</span>
			<h1 css={titleCss}>
				{props.heading ??
					`${props.clientLabel} wants to connect to your Kody account`}
			</h1>
		</header>
	)
}

export function OAuthAuthorizeSignedOutChoices(props: {
	clientLabel: string
	loginHref: string
	signupHref: string
	disabled: boolean
	tryingOut: boolean
	onTryItOut: () => void
}) {
	return (
		<section css={choicesCss} data-testid="oauth-authorize-choices">
			<SiteLink
				href={props.loginHref}
				css={primaryLinkCss}
				data-testid="oauth-authorize-login"
			>
				Log in
			</SiteLink>
			<SiteLink
				href={props.signupHref}
				css={secondaryLinkCss}
				data-testid="oauth-authorize-signup"
			>
				Sign up
			</SiteLink>
			<div role="separator" css={dividerCss}>
				<span>or</span>
			</div>
			<div css={tryBoxCss}>
				<button
					type="button"
					data-testid="oauth-authorize-try-it-out"
					disabled={props.disabled}
					onClick={props.onTryItOut}
					css={tryButtonCss}
				>
					{props.tryingOut ? 'Setting up...' : 'Try it out'}
				</button>
				<p css={tryLineCss}>
					No account needed. Full access for 24 hours, then claim it to keep
					everything.
				</p>
			</div>
			<p css={mutedLineCss}>
				<span css={inlineIconCss}>{renderIcon('message')}</span>
				<span>
					When you're ready to keep it, just tell {props.clientLabel} to claim
					your account.
				</span>
			</p>
		</section>
	)
}

export function OAuthAuthorizeGuestConnected(props: {
	clientLabel: string
	connection: GuestConnection
}) {
	const deadline = formatGuestDeadline(props.connection.expiresAt)
	return (
		<section css={connectedCss} data-testid="oauth-authorize-guest-connected">
			<span css={checkBadgeCss} aria-hidden="true">
				{renderIcon('check', { size: '1.6rem' })}
			</span>
			<h1 css={titleCss}>You're connected</h1>
			<a
				href={props.connection.redirectTo}
				css={primaryLinkCss}
				data-testid="oauth-authorize-guest-return"
			>
				Return to {props.clientLabel}
			</a>
			<div css={claimBoxCss}>
				<span css={claimLabelCss}>Your claim link</span>
				<div css={claimRowCss}>
					<code css={claimUrlCss} data-testid="oauth-authorize-guest-claim-url">
						{displayClaimUrl(props.connection.claimUrl)}
					</code>
					<CopyTextButton
						value={props.connection.claimUrl}
						variant="secondary"
						size="sm"
						idleLabel="Copy"
						ariaLabel="Copy claim link"
					/>
				</div>
				<p css={deadlineCss}>Full access until {deadline}</p>
				<p css={mutedLineCss}>
					<span css={inlineIconCss}>{renderIcon('message')}</span>
					<span>
						Or just tell {props.clientLabel} when you're ready to claim your
						account.
					</span>
				</p>
			</div>
			<ul css={checkListCss}>
				<li css={checkItemCss}>
					<span css={checkItemIconCss}>{renderIcon('check')}</span>
					<span>Claim before {deadline} to keep everything you make.</span>
				</li>
				<li css={checkItemCss}>
					<span css={checkItemIconCss}>{renderIcon('check')}</span>
					<span>
						Claiming keeps this same connection. No need to reconnect or log in
						again.
					</span>
				</li>
			</ul>
		</section>
	)
}

export function OAuthAuthorizeDisconnectFooter(props: { clientLabel: string }) {
	return (
		<p css={footerCss} data-testid="oauth-authorize-footer">
			You can disconnect {props.clientLabel} anytime from your Kody account.
		</p>
	)
}

const headerCss = {
	display: 'grid',
	justifyItems: 'center',
	gap: spacing.sm,
	textAlign: 'center' as const,
}
const iconRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	marginBottom: spacing.xs,
}
const iconWellCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '3rem',
	height: '3rem',
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	color: colors.text,
}
const clientIconCss = {
	...iconWellCss,
	fontWeight: typography.fontWeight.semibold,
	fontSize: typography.fontSize.lg,
}
const kodyIconCss = {
	...iconWellCss,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'none', borderColor: colors.primary },
}
const linkGlyphCss = { display: 'inline-flex', color: colors.textMuted }
const titleCss = { ...pageTitleCss, textAlign: 'center' as const }
const choicesCss = { display: 'grid', gap: spacing.sm }
const primaryButtonCss = getPrimaryButtonCss({ size: 'lg', weight: 'semibold' })
const secondaryButtonCss = getSecondaryButtonCss({
	size: 'lg',
	weight: 'semibold',
})
const fullWidthLinkCss = {
	width: '100%',
	justifyContent: 'center',
	textAlign: 'center' as const,
	textDecoration: 'none',
	'&:hover': { textDecoration: 'none' },
}
const primaryLinkCss = { ...primaryButtonCss, ...fullWidthLinkCss }
const secondaryLinkCss = { ...secondaryButtonCss, ...fullWidthLinkCss }
const dividerCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	'&::before, &::after': {
		content: '""',
		flex: 1,
		borderTop: `1px solid ${colors.border}`,
	},
}
const tryBoxCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	borderRadius: radius.lg,
	border: `1px solid ${colors.primarySoft}`,
	backgroundColor: colors.primarySoftest,
}
const tryButtonCss = { ...secondaryButtonCss, width: '100%' }
const tryLineCss = {
	margin: 0,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	textAlign: 'center' as const,
}
const mutedLineCss = {
	margin: 0,
	display: 'flex',
	alignItems: 'flex-start',
	justifyContent: 'center',
	gap: spacing.xs,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
const inlineIconCss = {
	display: 'inline-flex',
	flexShrink: 0,
	marginTop: '0.15em',
}
const connectedCss = {
	display: 'grid',
	justifyItems: 'center',
	gap: spacing.md,
	textAlign: 'center' as const,
}
const checkBadgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '3rem',
	height: '3rem',
	borderRadius: '999px',
	backgroundColor: colors.primarySoft,
	color: colors.primary,
}
const claimBoxCss = {
	width: '100%',
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	textAlign: 'left' as const,
}
const claimLabelCss = {
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.text,
}
const claimRowCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
}
const claimUrlCss = {
	flex: 1,
	minWidth: 0,
	padding: `${spacing.xs} ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere' as const,
}
const deadlineCss = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.medium,
	color: colors.text,
}
const checkListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
	width: '100%',
	textAlign: 'left' as const,
}
const checkItemCss = {
	display: 'flex',
	gap: spacing.sm,
	alignItems: 'flex-start',
	color: colors.text,
	fontSize: typography.fontSize.sm,
}
const checkItemIconCss = {
	...inlineIconCss,
	color: colors.primary,
}
const footerCss = {
	...descriptionCss,
	margin: 0,
	textAlign: 'center' as const,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
