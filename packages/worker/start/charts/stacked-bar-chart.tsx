/** @jsxImportSource @emotion/react */
import { useMemo } from 'react'
import { defineChart, barY } from '@tanstack/charts'
import { Chart } from '@tanstack/charts/react'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { scaleBand } from '@tanstack/charts/scales/band'
import { tooltip } from '@tanstack/charts/tooltip'
import {
	chartScrollerNewestFirstCss,
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
	/** Unique chart id (must be unique per page). */
	id: string
	series: Array<StackedBarSeries>
	xLabels: Array<string>
	ariaLabel: string
	xTickEvery?: number
	height?: number
	/**
	 * Initial chart width. Use a smaller value for narrow cards to
	 * reduce the minimum scrollable width.
	 */
	viewBoxWidth?: number
}

export function StackedBarChart(props: StackedBarChartProps) {
	const { id, series, xLabels, ariaLabel } = props
	const definition = useMemo(() => {
		const rows = series.flatMap((entry, seriesIndex) =>
			xLabels.map((label, index) => ({
				index,
				label,
				series: entry.label,
				color: entry.color,
				value: entry.values[index] ?? 0,
				key: `${seriesIndex}:${index}`,
			})),
		)
		const max = Math.max(
			1,
			...xLabels.map((_, index) =>
				series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0),
			),
		)
		const every = props.xTickEvery ?? Math.max(1, Math.ceil(xLabels.length / 6))
		return defineChart({
			marks: [
				barY(rows, {
					x: 'index',
					y: 'value',
					z: 'series',
					key: 'key',
					fill: (row) => row.color,
					maxThickness: 34,
					radius: { end: 5 },
				}),
			],
			scales: {
				x: {
					scale: () => scaleBand<number>().padding(0.38),
					domain: xLabels.map((_, index) => index),
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
			<div
				css={{ minWidth: (props.viewBoxWidth ?? 720) * 0.85, direction: 'ltr' }}
			>
				<Chart
					definition={definition}
					height={props.height ?? 230}
					initialWidth={props.viewBoxWidth ?? 720}
					idPrefix={id}
					ariaLabel={ariaLabel}
				/>
			</div>
		</div>
	)
}
