/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'
import type { ComponentProps } from 'react'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

const tableCss = {
	width: '100%',
	borderCollapse: 'collapse',
	fontSize: typography.fontSize.sm,
	color: colors.text,
	'& th, & td': {
		textAlign: 'start',
		verticalAlign: 'top',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
	},
	'& thead th': {
		color: colors.textMuted,
		fontWeight: typography.fontWeight.semibold,
	},
	'& caption': {
		captionSide: 'top',
		textAlign: 'start',
		color: colors.textMuted,
		paddingBottom: spacing.xs,
	},
} satisfies CSSObject

export type TableProps = ComponentProps<'table'>

/**
 * A native data table with the shared cell styling. Compose it with native
 * `caption`, `thead`, `tbody`, `tr`, `th scope`, and `td` children, and name it
 * with a `caption`, `aria-label`, or `aria-labelledby`.
 */
export function Table(props: TableProps) {
	return <table {...props} css={tableCss} />
}
