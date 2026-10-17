/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'
import { SiteLink } from './site-link.tsx'
import { colors, transitions, typography } from '#universal/styles/tokens.ts'
import {
	layoutMaxWidths,
	pageGutter,
} from '#universal/styles/style-primitives.ts'

export type SiteFooterProps = {
	loggedIn: boolean
	loginHref: string
}

/**
 * Site footer from the 2026 landing redesign: brand, the tagline voice line,
 * and footer nav. Color scheme follows the system preference.
 */
export function SiteFooter(props: SiteFooterProps) {
	return (
		<footer css={footerCss}>
			<div css={footerInnerCss}>
				<SiteLink href="/" css={brandCss}>
					<img
						src={publicAsset('/images/kody-mark.png')}
						alt=""
						width={28}
						height={28}
					/>
					<span>Kody</span>
				</SiteLink>
				<p css={taglineCss}>
					{props.loggedIn ? (
						'You\u2019re home'
					) : (
						<>
							Welcome{' '}
							<SiteLink href="/signup" css={taglineLinkCss}>
								home
							</SiteLink>
						</>
					)}
				</p>
				<nav aria-label="Footer" css={footerNavCss}>
					<SiteLink href="/features">Features</SiteLink>
					<SiteLink href="/community">Community</SiteLink>
					<SiteLink href="/discord">Discord</SiteLink>
					<SiteLink href="/docs">Docs</SiteLink>
					<SiteLink href="/use-cases">Use cases</SiteLink>
					<SiteLink href="/pricing">Pricing</SiteLink>
					<SiteLink href="/faq">FAQ</SiteLink>
					<SiteLink href="/about">About</SiteLink>
					<SiteLink href="/contact">Contact</SiteLink>
					<SiteLink href="/support">Support</SiteLink>
					<SiteLink href="/blog">Blog</SiteLink>
					<SiteLink
						href="https://github.com/kody-hq/kody"
						target="_blank"
						rel="noreferrer noopener"
					>
						GitHub
					</SiteLink>
					<SiteLink href="/privacy">Privacy</SiteLink>
					<SiteLink href="/terms">Terms</SiteLink>
					{props.loggedIn ? (
						<SiteLink href="/account">Account</SiteLink>
					) : (
						<SiteLink href={props.loginHref}>Log in</SiteLink>
					)}
					<section aria-labelledby="footer-for-heading" css={footerAudienceCss}>
						<h2 id="footer-for-heading">For</h2>
						<SiteLink href="/for/business">Business</SiteLink>
					</section>
				</nav>
			</div>
		</footer>
	)
}

const footerCss: CSSObject = {
	borderTop: `1px solid ${colors.border}`,
	viewTransitionName: 'site-footer',
}

const footerLinkColumnMin = '7.5rem'
/* Stay stacked until the 5-column nav fits beside brand + tagline. */
const footerStackMq = '@media (max-width: 900px)'

const footerInnerCss: CSSObject = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	paddingBlock: '2.2rem',
	paddingInline: pageGutter,
	display: 'grid',
	gridTemplateColumns: '1fr auto 1fr',
	alignItems: 'center',
	gap: '1.2rem 2rem',
	fontSize: '0.92rem',
	color: colors.textMuted,
	[footerStackMq]: {
		gridTemplateColumns: '1fr',
		justifyItems: 'center',
	},
}

const brandCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.6rem',
	minHeight: '44px',
	font: `700 1.25rem/1 ${typography.fontFamilyDisplay}`,
	color: colors.text,
	textDecoration: 'none',
	letterSpacing: '-0.01em',
	'&:hover': { color: colors.text },
}

/* The tagline is the voice bit of the footer , display face. */
const taglineCss: CSSObject = {
	margin: 0,
	textAlign: 'center' as const,
	fontFamily: typography.fontFamilyDisplay,
	fontOpticalSizing: 'auto' as const,
}

const taglineLinkCss: CSSObject = {
	color: colors.primaryText,
	fontWeight: 600,
	textDecorationThickness: '1.5px',
	textUnderlineOffset: '3px',
	'&:hover': { color: colors.text },
}

const footerNavCss: CSSObject = {
	/* Wide footer: a two-row, five-column row-major grid, not flex-wrap.
	   Wrapping left the first few links on one row and stacked the rest. */
	display: 'grid',
	gridTemplateColumns: 'repeat(5, max-content)',
	columnGap: '1.4rem',
	rowGap: '0.35rem',
	justifySelf: 'end',
	justifyContent: 'end',
	'& a': {
		color: colors.textMuted,
		textDecoration: 'none',
		whiteSpace: 'nowrap' as const,
		// Same fast color ease as the header nav , one voice for nav links.
		transition: `color ${transitions.fast}`,
	},
	'& a:hover': { color: colors.text },
	/* Stacked footer: wrap into as many columns as the inner measure holds
	   instead of one 10-row ladder or a nowrap row that clips. auto-fit with
	   min(100%, …) collapses to a single column before it overflows. */
	[footerStackMq]: {
		display: 'grid',
		width: '100%',
		gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${footerLinkColumnMin}), max-content))`,
		justifySelf: 'center',
		justifyContent: 'center',
		columnGap: '1.25rem',
		rowGap: '0.15rem',
		'& a': {
			display: 'flex',
			alignItems: 'center',
			minHeight: '44px',
			padding: '0.55rem 0.75rem',
		},
	},
}

const footerAudienceCss: CSSObject = {
	gridColumn: '1 / -1',
	marginTop: '1rem',
	'& h2': {
		margin: '0 0 0.5rem',
		color: colors.text,
		font: `600 0.92rem/1.4 ${typography.fontFamily}`,
	},
	[footerStackMq]: {
		textAlign: 'center' as const,
		'& a': { display: 'inline-flex' },
	},
}
