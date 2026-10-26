/** @jsxImportSource @emotion/react */
import { useMemo } from 'react'
import { defineChart, areaY, lineY, dot } from '@tanstack/charts'
import { decorative } from '@tanstack/charts/mark/decorative'
import { Chart } from '@tanstack/charts/react'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { d3Curve } from '@tanstack/charts/d3/shape'
import { curveMonotoneX } from 'd3-shape'
import { colors } from '#universal/styles/tokens.ts'
import { tooltip } from '@tanstack/charts/tooltip'
import {
	chartScrollerNewestFirstCss,
	formatCompactNumber,
	formatIntegerNumber,
} from '#client/charts/chart-theme.ts'

const smoothCurve = d3Curve(curveMonotoneX)

type AreaChartSeries = {
	label: string
	color: string
	values: Array<number>
}

type AreaChartProps = {
	/** Unique chart id (must be unique per page). */
	id: string
	series: Array<AreaChartSeries>
	/** One label per data point, oldest first. */
	xLabels: Array<string>
	ariaLabel: string
	/** Render every nth x axis label (default: fit about six labels). */
	xTickEvery?: number
	height?: number
}

export function AreaChart(props: AreaChartProps) {
	const { id, series, xLabels, ariaLabel } = props
	const definition = useMemo(() => {
		const rows = series.flatMap((entry, seriesIndex) =>
			xLabels.map((label, index) => ({
				index,
				label,
				series: entry.label,
				color: entry.color,
				gradient: `area-${seriesIndex}`,
				value: entry.values[index] ?? 0,
				key: `${seriesIndex}:${index}`,
			})),
		)
		const max = Math.max(1, ...rows.map((row) => row.value))
		const every = props.xTickEvery ?? Math.max(1, Math.ceil(xLabels.length / 6))
		return defineChart({
			gradients: series.map((entry, index) => ({
				id: `area-${index}`,
				x1: 0,
				x2: 0,
				y1: 0,
				y2: 1,
				stops: [
					{ offset: 0, color: entry.color, opacity: 0.32 },
					{ offset: 1, color: entry.color, opacity: 0 },
				],
			})),
			marks: [
				decorative(
					areaY(rows, {
						x: 'index',
						y1: 0,
						y2: 'value',
						z: 'series',
						key: 'key',
						fill: (row) => `url(#${row.gradient})`,
						fillOpacity: 1,
						curve: smoothCurve,
					}),
				),
				lineY(rows, {
					x: 'index',
					y: 'value',
					z: 'series',
					key: 'key',
					stroke: (row) => row.color,
					strokeWidth: 2.5,
					curve: smoothCurve,
				}),
				...series.map((entry) =>
					decorative(
						dot(
							rows.filter(
								(row) =>
									row.series === entry.label &&
									row.index === xLabels.length - 1,
							),
							{
								x: 'index',
								y: 'value',
								fill: entry.color,
								r: 4,
								stroke: colors.surface,
								strokeWidth: 1.5,
							},
						),
					),
				),
			],
			scales: {
				x: {
					scale: scaleLinear,
					domain:
						xLabels.length === 1
							? [-0.5, 0.5]
							: [0, Math.max(1, xLabels.length - 1)],
					axis: {
						ticks: {
							values: xLabels
								.map((_, index) => index)
								.filter((index) => index % every === 0),
							format: (index) => xLabels[index] ?? '',
						},
					},
				},
				y: {
					scale: scaleLinear,
					domain: [0, max],
					nice: true,
					grid: true,
					axis: { ticks: { format: formatCompactNumber } },
				},
			},
			tooltip: {
				use: tooltip,
				format: (point) =>
					`${point.datum.label} · ${point.datum.series}: ${formatIntegerNumber(point.datum.value)}`,
			},
		})
	}, [series, xLabels, props.xTickEvery])
	return (
		<div css={chartScrollerNewestFirstCss}>
			<div css={{ minWidth: 612, direction: 'ltr' }}>
				<Chart
					definition={definition}
					height={props.height ?? 230}
					initialWidth={720}
					idPrefix={id}
					ariaLabel={ariaLabel}
				/>
			</div>
		</div>
	)
}
