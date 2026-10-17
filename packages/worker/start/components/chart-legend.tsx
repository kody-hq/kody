/** @jsxImportSource @emotion/react */

import { colors, spacing, typography } from '#universal/styles/tokens.ts'
type ChartLegendItem = {
	label: string
	color: string
	value?: string
}
type ChartLegendProps = {
	items: Array<ChartLegendItem>
}
/** Wrapped inline legend of colored dots for the larger charts. */
export function ChartLegend(props: ChartLegendProps) {
	return (
		<ul
			css={{
				listStyle: 'none',
				margin: 0,
				padding: 0,
				display: 'flex',
				flexWrap: 'wrap',
				gap: `${spacing.xs} ${spacing.lg}`,
			}}
		>
			{props.items.map((item) => (
				<li
					key={item.label}
					css={{
						display: 'flex',
						alignItems: 'center',
						gap: spacing.sm,
						fontSize: typography.fontSize.sm,
						color: colors.textMuted,
					}}
				>
					<span
						aria-hidden="true"
						css={{
							width: '0.625rem',
							height: '0.625rem',
							borderRadius: '999px',
							backgroundColor: item.color,
							flexShrink: 0,
						}}
					/>
					{item.label}
					{item.value ? (
						<span
							css={{
								color: colors.text,
								fontWeight: typography.fontWeight.medium,
								fontVariantNumeric: 'tabular-nums',
							}}
						>
							{item.value}
						</span>
					) : null}
				</li>
			))}
		</ul>
	)
}
