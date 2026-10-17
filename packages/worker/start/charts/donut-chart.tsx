/** @jsxImportSource @emotion/react */

import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	buildDonutSegments,
	describeArc,
} from '#client/charts/chart-geometry.ts'
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

const size = 180
const radius = 66
const strokeWidth = 26
const center = size / 2

/**
 * Donut chart with a center total and a wrapped legend showing counts and
 * percent shares. Slices get native hover tooltips.
 */
export function DonutChart(props: DonutChartProps) {
	const { slices, centerLabel, ariaLabel } = props
	const total = slices.reduce((sum, slice) => sum + slice.value, 0)
	const segments = buildDonutSegments(slices.map((slice) => slice.value))
	return (
		<div
			css={{
				display: 'flex',
				gap: spacing.lg,
				alignItems: 'center',
				flexWrap: 'wrap',
			}}
		>
			<svg
				viewBox={`0 0 ${size} ${size}`}
				role="img"
				aria-label={ariaLabel}
				css={{ width: '11.25rem', maxWidth: '100%', flexShrink: 0 }}
			>
				{total <= 0 ? (
					<circle
						cx={center}
						cy={center}
						r={radius}
						fill="none"
						stroke={chartEmptyFill}
						strokeWidth={strokeWidth}
					/>
				) : (
					slices.map((slice, index) => {
						const segment = segments[index]
						if (!segment || segment.fraction <= 0) return null
						// A single full-circle slice cannot be drawn with an arc
						// command (start and end coincide), so use a circle.
						if (segment.fraction >= 1) {
							return (
								<circle
									key={slice.label}
									cx={center}
									cy={center}
									r={radius}
									fill="none"
									stroke={slice.color}
									strokeWidth={strokeWidth}
								>
									<title>{`${slice.label}: ${formatIntegerNumber(slice.value)} (100%)`}</title>
								</circle>
							)
						}
						return (
							<path
								key={slice.label}
								d={describeArc(
									center,
									center,
									radius,
									segment.startAngle,
									segment.endAngle,
								)}
								fill="none"
								stroke={slice.color}
								strokeWidth={strokeWidth}
								css={{
									transition: 'opacity var(--transition-fast)',
									'&:hover': { opacity: 0.8 },
								}}
							>
								<title>{`${slice.label}: ${formatIntegerNumber(slice.value)} (${formatPercentShare(segment.fraction)})`}</title>
							</path>
						)
					})
				)}
				<text
					x={center}
					y={center - 4}
					textAnchor="middle"
					css={{
						fill: colors.text,
						fontSize: '26px',
						fontWeight: typography.fontWeight.semibold,
						fontFamily: typography.fontFamily,
					}}
				>
					{formatIntegerNumber(total)}
				</text>
				<text
					x={center}
					y={center + 16}
					textAnchor="middle"
					css={{
						fill: colors.textMuted,
						fontSize: '11px',
						fontFamily: typography.fontFamily,
					}}
				>
					{centerLabel}
				</text>
			</svg>
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
