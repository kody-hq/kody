/** @jsxImportSource @emotion/react */
import { type ReactNode, type CSSProperties } from 'react'
import { type CSSObject } from '@emotion/react'
import { colors } from '#universal/styles/tokens.ts'
import {
	renderLoginVisualPanel,
	renderMobileBrand,
} from '../pages/login-sections.tsx'
import { SiteLink } from './site-link.tsx'
export function AuthLayout({
	title,
	description,
	children,
}: {
	title: string
	description?: string
	children: ReactNode
}) {
	return (
		<div css={authLayoutCss}>
			{renderLoginVisualPanel()}
			<div css={authPanelCss}>
				{renderMobileBrand()}
				<div css={authCardCss}>
					<header
						data-rise
						style={{ '--rise': '0' } as CSSProperties}
						css={authHeadCss}
					>
						<h1>{title}</h1>
						{description && <p>{description}</p>}
					</header>
					{children}
				</div>
				<div css={authCornerCss}>
					<SiteLink href="/">&larr; Back to Kody</SiteLink>
				</div>
			</div>
		</div>
	)
}
const mobileMq = '@media (max-width: 900px)'
const authLayoutCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
	width: '100%',
	[mobileMq]: {
		gridTemplateColumns: '1fr',
	},
}

const authPanelCss: CSSObject = {
	display: 'flex',
	flexDirection: 'column' as const,
	justifyContent: 'center',
	gap: '2rem',
	padding: 'clamp(1.5rem, 4vw, 3rem)',
	position: 'relative' as const,
	backgroundColor: colors.surface,
	[mobileMq]: {
		justifyContent: 'flex-start',
		/* Was clamp(4.5rem, 12vw, 6rem) to clear the absolutely positioned
		   corner. The corner is hidden at this breakpoint now, so the panel only
		   needs its own breathing room. */
		paddingTop: 'clamp(1.75rem, 6vw, 2.75rem)',
	},
}

const authCardCss: CSSObject = {
	width: 'min(100%, 400px)',
	marginInline: 'auto',
	display: 'flex',
	flexDirection: 'column' as const,
	gap: '1.7rem',
}

const authHeadCss: CSSObject = {
	'& h1': {
		margin: 0,
		fontSize: 'clamp(1.9rem, 3vw, 2.3rem)',
		fontWeight: 760,
		letterSpacing: '-0.025em',
		lineHeight: 1.05,
	},
	'& p': {
		margin: '0.5rem 0 0',
		color: colors.textMuted,
	},
	/* Centred on phones to sit under the centred brand mark; the two-panel
	   desktop layout keeps the heading left-aligned with the form below it. */
	[mobileMq]: {
		textAlign: 'center' as const,
	},
}

const authCornerCss: CSSObject = {
	position: 'absolute' as const,
	top: 'clamp(1rem, 2.5vw, 1.8rem)',
	right: 'clamp(1rem, 2.5vw, 1.8rem)',
	display: 'flex',
	alignItems: 'center',
	gap: '1.1rem',
	fontSize: '0.92rem',
	'& > a': {
		color: colors.textMuted,
		textDecoration: 'none',
	},
	'& > a:hover': { color: colors.text },
	/*
	 * Gone on phones, where this floated over the top of the card and crowded
	 * the brand. The "back" link is redundant there because `authBrandMobileCss`
	 * puts a real link home inside the card at this breakpoint — which is also
	 * why the corner has to stay on wider screens, where that in-card brand is
	 * `display: none` and the only other one is inside the `aria-hidden` visual
	 * panel at `tabIndex={-1}`. Hiding it there would leave no reachable way
	 * home.
	 */
	[mobileMq]: { display: 'none' },
}
