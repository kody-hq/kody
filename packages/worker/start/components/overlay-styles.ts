import { colors, radius, shadows, spacing } from '#universal/styles/tokens.ts'

export const overlayPositionerCss = { zIndex: 1000 }

export const overlayPopupCss = {
	boxSizing: 'border-box',
	maxWidth: 'var(--available-width)',
	maxHeight: 'min(280px, var(--available-height))',
	overflowY: 'auto',
	padding: spacing.xs,
	border: `1px solid ${colors.borderSubtle}`,
	borderRadius: radius.md,
	boxShadow: shadows.md,
	background: colors.surface,
	color: colors.text,
	fontSize: 13,
	outline: 'none',
} as const

export const overlayItemCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	padding: '7px 10px',
	borderRadius: radius.sm,
	color: colors.text,
	textDecoration: 'none',
	cursor: 'default',
	outline: 'none',
	'&[data-highlighted]': { background: colors.primarySoft },
	'&[data-disabled]': { opacity: 0.5 },
} as const
