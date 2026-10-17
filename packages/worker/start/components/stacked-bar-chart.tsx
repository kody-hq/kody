/** @jsxImportSource @emotion/react */

import { buildTicks } from '#client/charts/chart-geometry.ts'
import {
	chartAxisTextCss,
	chartGridStroke,
	chartScrollerNewestFirstCss,
	chartSvgCss,
	formatCompactNumber,
	formatIntegerNumber,
} from '#client/charts/chart-theme.ts'
type StackedBarSeries = {
	label: string
	color: string
	/** One value per x label, oldest first. */
	values: Array<number>
}
type StackedBarChartProps = {
	/** Unique id prefix for clip paths (must be unique per page). */
	id: string
	series: Array<StackedBarSeries>
	xLabels: Array<string>
	ariaLabel: string
	xTickEvery?: number
	height?: number
	/**
	 * ViewBox width. Use a smaller value for charts rendered in narrow
	 * cards so axis text keeps a readable on-screen size.
	 */
	viewBoxWidth?: number
}
const pad = { top: 14, right: 16, bottom: 26, left: 46 }
/**
 * Stacked bar chart with rounded column tops (via per-column clip paths),
 * grid lines, and native hover tooltips.
 */
export function StackedBarChart(props: StackedBarChartProps) {
	const { id, series, xLabels, ariaLabel } = props
	const width = props.viewBoxWidth ?? 720
	const height = props.height ?? 230
	const plotWidth = width - pad.left - pad.right
	const plotHeight = height - pad.top - pad.bottom
	const baselineY = pad.top + plotHeight
	const pointCount = Math.max(1, xLabels.length)
	const columnTotals = xLabels.map((_, index) =>
		series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0),
	)
	const ticks = buildTicks(Math.max(0, ...columnTotals))
	const topTick = ticks[ticks.length - 1] ?? 1
	const slotWidth = plotWidth / pointCount
	const barWidth = Math.min(34, slotWidth * 0.62)
	const cornerRadius = Math.min(5, barWidth / 2)
	const heightFor = (value: number) => (plotHeight * value) / topTick
	const xTickEvery = props.xTickEvery ?? Math.max(1, Math.ceil(pointCount / 6))
	return (
		<div css={chartScrollerNewestFirstCss}>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label={ariaLabel}
				css={chartSvgCss(width)}
			>
				{ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={pad.left}
							y1={baselineY - heightFor(tick)}
							x2={width - pad.right}
							y2={baselineY - heightFor(tick)}
							stroke={chartGridStroke}
							strokeWidth="1"
							strokeDasharray={tick === 0 ? undefined : '3 5'}
						/>
						<text
							x={pad.left - 8}
							y={baselineY - heightFor(tick) + 3.5}
							textAnchor="end"
							css={chartAxisTextCss}
						>
							{formatCompactNumber(tick)}
						</text>
					</g>
				))}
				{xLabels.map((label, index) => {
					const total = columnTotals[index] ?? 0
					const barX = pad.left + slotWidth * index + (slotWidth - barWidth) / 2
					const barTop = baselineY - heightFor(total)
					let stackY = baselineY
					return (
						<g key={`${label}-${index}`}>
							{total > 0 ? (
								<>
									<clipPath id={`${id}-clip-${index}`}>
										<rect
											x={barX}
											y={barTop}
											width={barWidth}
											height={baselineY - barTop}
											rx={cornerRadius}
										/>
									</clipPath>
									<g clipPath={`url(#${id}-clip-${index})`}>
										{series.map((entry) => {
											const segmentHeight = heightFor(entry.values[index] ?? 0)
											stackY -= segmentHeight
											return (
												<rect
													key={entry.label}
													x={barX}
													y={stackY}
													width={barWidth}
													height={segmentHeight}
													fill={entry.color}
												/>
											)
										})}
									</g>
								</>
							) : null}
							{index % xTickEvery === 0 ? (
								<text
									x={barX + barWidth / 2}
									y={height - 8}
									textAnchor="middle"
									css={chartAxisTextCss}
								>
									{label}
								</text>
							) : null}
							<rect
								x={pad.left + slotWidth * index}
								y={pad.top}
								width={slotWidth}
								height={plotHeight}
								fill="transparent"
								css={{
									'&:hover': {
										fill: 'color-mix(in srgb, var(--color-primary) 7%, transparent)',
									},
								}}
							>
								<title>
									{[
										`${label} — total ${formatIntegerNumber(total)}`,
										...series
											.filter((entry) => (entry.values[index] ?? 0) > 0)
											.map(
												(entry) =>
													`${entry.label}: ${formatIntegerNumber(entry.values[index] ?? 0)}`,
											),
									].join('\n')}
								</title>
							</rect>
						</g>
					)
				})}
			</svg>
		</div>
	)
}
