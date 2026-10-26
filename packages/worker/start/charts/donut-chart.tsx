/** @jsxImportSource @emotion/react */

import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { useMemo } from 'react'
import { defineChart } from '@tanstack/charts'
import { Chart } from '@tanstack/charts/react'
import { pie, polar, radialArc } from '@tanstack/charts/polar'
import { tooltip } from '@tanstack/charts/tooltip'
import {
	chartEmptyFill,
	formatIntegerNumber,
	formatPercentShare,
} from '#client/charts/chart-theme.ts'

type DonutSlice = {
	label: string
	value: number
	color: string
}

type DonutChartProps = {
	slices: Array<DonutSlice>
	centerLabel: string
	ariaLabel: string
	/** Text shown when every slice is zero. */
	emptyText?: string
}

export function DonutChart(props: DonutChartProps) {
	const { slices, centerLabel, ariaLabel } = props
	const total = slices.reduce((sum, slice) => sum + slice.value, 0)
	const definition = useMemo(
		() =>
			defineChart({
				marks: [
					polar({
						scales: { angle: null, radius: null },
						inset: 11,
						marks: [
							radialArc(
								pie(
									total > 0
										? slices
										: [{ label: centerLabel, value: 1, color: chartEmptyFill }],
									{ value: 'value' },
								),
								{
									key: 'label',
									fill: (slice) => slice.color,
									innerRadius: ({ radius }) => (radius * 53) / 79,
								},
							),
						],
					}),
				],
				scales: { x: null, y: null },
				guides: false,
				tooltip:
					total > 0
						? {
								use: tooltip,
								format: (point) =>
									`${point.datum.label}: ${formatIntegerNumber(point.datum.value)} (${formatPercentShare(point.datum.fraction)})`,
							}
						: undefined,
			}),
		[slices, total, centerLabel],
	)
	return (
		<div
			css={{
				display: 'flex',
				gap: spacing.lg,
				alignItems: 'center',
				flexWrap: 'wrap',
			}}
		>
			<div
				css={{
					position: 'relative',
					width: '11.25rem',
					maxWidth: '100%',
					flexShrink: 0,
				}}
			>
				<Chart
					definition={definition}
					height={180}
					initialWidth={180}
					ariaLabel={ariaLabel}
				/>
				<div
					css={{
						position: 'absolute',
						inset: 0,
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
						justifyContent: 'center',
						pointerEvents: 'none',
					}}
				>
					<span
						css={{
							color: colors.text,
							fontSize: '26px',
							fontWeight: typography.fontWeight.semibold,
						}}
					>
						{formatIntegerNumber(total)}
					</span>
					<span css={{ color: colors.textMuted, fontSize: '11px' }}>
						{centerLabel}
					</span>
				</div>
			</div>
			<ul
				css={{
					listStyle: 'none',
					margin: 0,
					padding: 0,
					display: 'grid',
					gap: spacing.xs,
					minWidth: 0,
				}}
			>
				{total <= 0 ? (
					<li
						css={{
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						{props.emptyText ?? 'No data yet.'}
					</li>
				) : (
					slices
						.filter((slice) => slice.value > 0)
						.map((slice) => (
							<li
								key={slice.label}
								css={{
									display: 'flex',
									alignItems: 'center',
									gap: spacing.sm,
									fontSize: typography.fontSize.sm,
									color: colors.text,
								}}
							>
								<span
									aria-hidden="true"
									css={{
										width: '0.625rem',
										height: '0.625rem',
										borderRadius: '999px',
										backgroundColor: slice.color,
										flexShrink: 0,
									}}
								/>
								<span css={{ minWidth: 0, overflowWrap: 'anywhere' }}>
									{slice.label}
								</span>
								<span
									css={{
										color: colors.textMuted,
										whiteSpace: 'nowrap',
										marginLeft: 'auto',
										paddingLeft: spacing.sm,
										fontVariantNumeric: 'tabular-nums',
									}}
								>
									{formatIntegerNumber(slice.value)} ·{' '}
									{formatPercentShare(slice.value / total)}
								</span>
							</li>
						))
				)}
			</ul>
		</div>
	)
}
