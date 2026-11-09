import type { CSSObject } from '@emotion/react'
import { colors, typography } from '#universal/styles/tokens.ts'
export const dialogCss: CSSObject = {
	padding: 0,
	width: 'min(720px, calc(100vw - 24px))',
	maxWidth: 'none',
	maxHeight: 'calc(100dvh - 40px)',
	margin: 'min(15vh, 100px) auto auto',
	border: `1px solid ${colors.border}`,
	borderRadius: 16,
	background: colors.surface,
	color: colors.text,
	fontFamily: typography.fontFamily,
	fontSize: 14,
	boxShadow: '0 24px 100px #0005',
	overflow: 'auto',
	'&::backdrop': { background: '#0006', backdropFilter: 'blur(4px)' },
	'& button:focus-visible, & select:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 2,
	},
	'@media (max-width:600px)': { margin: '12px auto', borderRadius: 12 },
}
export const inputCss: CSSObject = {
	flex: 1,
	minWidth: 0,
	border: 0,
	outline: 0,
	background: 'transparent',
	color: colors.text,
	font: 'inherit',
	fontSize: 17,
	padding: '4px 0',
	'&:focus-visible': { boxShadow: `0 2px 0 ${colors.primary}` },
}
export const rowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: 12,
	padding: '11px 12px',
	borderRadius: 9,
	cursor: 'pointer',
	minHeight: 50,
	boxSizing: 'border-box',
	'&[aria-selected="true"]': {
		background: colors.primarySoft,
		color: colors.primaryText,
	},
}
export const footerCss: CSSObject = {
	display: 'flex',
	gap: 8,
	alignItems: 'center',
	borderTop: `1px solid ${colors.border}`,
	padding: '10px 16px',
	fontSize: 12,
	color: colors.textMuted,
	flexWrap: 'wrap',
}
export const smallButtonCss: CSSObject = {
	border: `1px solid ${colors.border}`,
	borderRadius: 6,
	padding: '5px 8px',
	background: 'transparent',
	color: 'inherit',
	font: 'inherit',
	fontSize: 12,
	cursor: 'pointer',
	'&:hover': { background: colors.primarySoft },
	'&[aria-pressed="true"]': {
		background: colors.primarySoft,
		color: colors.primaryText,
	},
	'&:disabled': { opacity: 0.5, cursor: 'default' },
}
