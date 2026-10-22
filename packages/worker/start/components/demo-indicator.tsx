/** @jsxImportSource @emotion/react */
import { colors, spacing, typography } from '#universal/styles/tokens.ts'

export function DemoIndicator() {
	return (
		<span
			data-testid="demo-indicator"
			css={{
				fontSize: typography.fontSize.xs,
				fontWeight: typography.fontWeight.medium,
				color: colors.textMuted,
				border: `1px solid ${colors.border}`,
				borderRadius: '0.375rem',
				padding: `0 ${spacing.xs}`,
				lineHeight: 1.6,
				letterSpacing: '0.02em',
				textTransform: 'uppercase',
			}}
		>
			Demo
		</span>
	)
}
