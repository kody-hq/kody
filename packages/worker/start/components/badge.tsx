/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import type { ComponentProps } from 'react'
import { colors } from '#universal/styles/tokens.ts'

export type BadgeTone = 'neutral' | 'accent' | 'warning' | 'danger'

/*
 * One flex box for every tone, so badges sitting next to each other (or next
 * to a pill-shaped control built from `getBadgeCss`) line up exactly.
 */
const badgeBoxCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: '0.3rem',
	boxSizing: 'border-box',
	flex: 'none',
	margin: 0,
	fontFamily: 'inherit',
	fontSize: '0.78rem',
	fontWeight: 650,
	lineHeight: 1.2,
	borderRadius: '999px',
	padding: '0.15rem 0.6rem',
	border: '1px solid transparent',
	whiteSpace: 'nowrap',
	verticalAlign: 'middle',
} satisfies CSSObject

const toneCss = {
	neutral: {
		color: colors.textMuted,
		backgroundColor: colors.surface,
		borderColor: colors.border,
	},
	accent: {
		color: colors.primaryText,
		backgroundColor: colors.primarySoft,
	},
	warning: {
		color: colors.warningText,
		backgroundColor:
			'color-mix(in srgb, var(--color-warning) 18%, transparent)',
	},
	danger: {
		color: colors.danger,
		backgroundColor: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
	},
} satisfies Record<BadgeTone, CSSObject>

/** The badge look, for a pill-shaped control that sits in a row of badges. */
export function getBadgeCss(tone: BadgeTone = 'neutral'): CSSObject {
	return { ...badgeBoxCss, ...toneCss[tone] }
}

export type BadgeProps = ComponentProps<'span'> & { tone?: BadgeTone }

/** A short, non-interactive status label such as "Verified" or "Pending". */
export function Badge({ tone = 'neutral', ...props }: BadgeProps) {
	return <span {...props} css={getBadgeCss(tone)} />
}
