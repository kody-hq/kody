/** @jsxImportSource @emotion/react */

import { colors } from '#universal/styles/tokens.ts'
import {
	buildSmoothAreaPath,
	buildSmoothLinePath,
	buildTicks,
	type ChartPoint,
} from '#client/charts/chart-geometry.ts'
import {
	chartAxisTextCss,
	chartGridStroke,
	chartScrollerNewestFirstCss,
	chartSvgCss,
	formatCompactNumber,
	formatIntegerNumber,
	softColor,
} from '#client/charts/chart-theme.ts'

type AreaChartSeries = {
	label: string
	color: string
	values: Array<number>
}

type AreaChartProps = {
	/** Unique id prefix for gradient defs (must be unique per page). */
	id: string
	series: Array<AreaChartSeries>
	/** One label per data point, oldest first. */
	xLabels: Array<string>
	ariaLabel: string
	/** Render every nth x axis label (default: fit about six labels). */
	xTickEvery?: number
	height?: number
}

const width = 720
const pad = { top: 14, right: 16, bottom: 26, left: 46 }

/**
 * Smooth multi-series area chart with gradient fills, grid lines, and
 * native hover tooltips (per-column `<title>` elements).
 */
export function AreaChart(props: AreaChartProps) {
	const { id, series, xLabels, ariaLabel } = props
	const height = props.height ?? 230
	const plotWidth = width - pad.left - pad.right
	const plotHeight = height - pad.top - pad.bottom
	const baselineY = pad.top + plotHeight
	const pointCount = xLabels.length
	const maxValue = Math.max(
		0,
		...series.flatMap((entry) => entry.values.map((value) => value ?? 0)),
	)
	const ticks = buildTicks(maxValue)
	const topTick = ticks[ticks.length - 1] ?? 1
	const xAt = (index: number) =>
		pointCount <= 1
			? pad.left + plotWidth / 2
			: pad.left + (plotWidth * index) / (pointCount - 1)
	const yAt = (value: number) => baselineY - (plotHeight * value) / topTick
	const seriesPoints = series.map((entry) =>
		entry.values.map((value, index): ChartPoint => ({
			x: xAt(index),
			y: yAt(value ?? 0),
		})),
	)
	const xTickEvery = props.xTickEvery ?? Math.max(1, Math.ceil(pointCount / 6))
	return (
		<div css={chartScrollerNewestFirstCss}>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label={ariaLabel}
				css={chartSvgCss(width)}
			>
				<defs>
					{series.map((entry, seriesIndex) => (
						<linearGradient
							key={entry.label}
							id={`${id}-grad-${seriesIndex}`}
							x1="0"
							y1="0"
							x2="0"
							y2="1"
						>
							<stop offset="0%" stopColor={entry.color} stopOpacity="0.32" />
							<stop offset="100%" stopColor={entry.color} stopOpacity="0" />
						</linearGradient>
					))}
				</defs>
				{ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={pad.left}
							y1={yAt(tick)}
							x2={width - pad.right}
							y2={yAt(tick)}
							stroke={chartGridStroke}
							strokeWidth="1"
							strokeDasharray={tick === 0 ? undefined : '3 5'}
						/>
						<text
							x={pad.left - 8}
							y={yAt(tick) + 3.5}
							textAnchor="end"
							css={chartAxisTextCss}
						>
							{formatCompactNumber(tick)}
						</text>
					</g>
				))}
				{xLabels.map((label, index) =>
					index % xTickEvery === 0 ? (
						<text
							key={`${label}-${index}`}
							x={xAt(index)}
							y={height - 8}
							textAnchor="middle"
							css={chartAxisTextCss}
						>
							{label}
						</text>
					) : null,
				)}
				{series.map((entry, seriesIndex) => {
					const points = seriesPoints[seriesIndex] ?? []
					const lastPoint = points[points.length - 1]
					return (
						<g key={entry.label}>
							<path
								d={buildSmoothAreaPath(points, baselineY)}
								fill={`url(#${id}-grad-${seriesIndex})`}
							/>
							<path
								d={buildSmoothLinePath(points)}
								fill="none"
								stroke={entry.color}
								strokeWidth="2.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
							{lastPoint ? (
								<circle
									cx={lastPoint.x}
									cy={lastPoint.y}
									r="4"
									fill={entry.color}
									stroke={colors.surface}
									strokeWidth="1.5"
								/>
							) : null}
						</g>
					)
				})}
				{xLabels.map((label, index) => (
					<rect
						key={`hover-${label}-${index}`}
						x={
							pointCount <= 1
								? pad.left
								: xAt(index) - plotWidth / (pointCount - 1) / 2
						}
						y={pad.top}
						width={pointCount <= 1 ? plotWidth : plotWidth / (pointCount - 1)}
						height={plotHeight}
						fill="transparent"
						css={{
							'&:hover': { fill: softColor(colors.primary, 7) },
						}}
					>
						<title>
							{[
								label,
								...series.map(
									(entry) =>
										`${entry.label}: ${formatIntegerNumber(entry.values[index] ?? 0)}`,
								),
							].join('\n')}
						</title>
					</rect>
				))}
			</svg>
		</div>
	)
}
