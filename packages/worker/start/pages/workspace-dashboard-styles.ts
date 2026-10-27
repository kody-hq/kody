import { surfaceCardCss } from '#universal/styles/surface.ts'
import { type CSSObject } from '@emotion/react'
import { colors } from '#universal/styles/tokens.ts'

export const dashboardPanelCss: CSSObject = {
	...surfaceCardCss,
	minWidth: 0,
	overflow: 'hidden',
}

export const dashboardHeaderCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	flexWrap: 'wrap',
	gap: '0.75rem',
	padding: '1.25rem 1.25rem 0.75rem',
}

export const dashboardHeadingCss: CSSObject = {
	margin: 0,
	display: 'flex',
	alignItems: 'center',
	gap: '0.6rem',
	fontSize: '0.9rem',
	fontWeight: 650,
	'& svg': { color: colors.textMuted, flexShrink: 0 },
}

export const dashboardLinkCss: CSSObject = {
	fontSize: '0.8rem',
	color: colors.primaryText,
	textDecoration: 'none',
	borderRadius: '0.4rem',
	'&:hover': { textDecoration: 'underline' },
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 4,
	},
}

export const dashboardIconCss: CSSObject = {
	display: 'grid',
	placeItems: 'center',
	width: '2.5rem',
	height: '2.5rem',
	flexShrink: 0,
	borderRadius: '0.75rem',
	color: colors.primaryText,
	background: `linear-gradient(135deg, ${colors.primarySoft}, ${colors.primarySoftest})`,
	boxShadow: `inset 0 1px 0 color-mix(in srgb, ${colors.primary} 10%, transparent)`,
}
