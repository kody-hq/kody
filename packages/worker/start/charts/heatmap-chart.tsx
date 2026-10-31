/** @jsxImportSource @emotion/react */
import { xyChartDefaults } from './xy-chart-defaults.ts'
import { tooltipRows } from './tooltip-content.ts'
import { useMemo } from 'react'
import { cell, defineChart } from '@tanstack/charts'
import { Chart } from './chart.tsx'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleOrdinal } from '@tanstack/charts/scales/ordinal'
import { tooltip } from '@tanstack/charts/tooltip'
import {
	chartEmptyFill,
	chartScrollerCss,
	softColor,
} from '#client/charts/chart-theme.ts'

type HeatmapCell = {
	/** 0 = Sunday through 6 = Saturday, matching `Date#getUTCDay`. */
	weekday: number
	/** Hour of day, 0-23. */
	hour: number
	count: number
}

type HeatmapChartProps = {
	cells: Array<HeatmapCell>
	color: string
	ariaLabel: string
	/** Tooltip noun, for example `auth events`. */
	unitLabel: string
}

// Rows are displayed Monday-first.
const weekdayRows = [1, 2, 3, 4, 5, 6, 0] as const
const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function HeatmapChart({
	cells,
	color,
	ariaLabel,
	unitLabel,
}: HeatmapChartProps) {
	const definition = useMemo(() => {
		const counts = new Map(
			cells.map((entry) => [`${entry.weekday}:${entry.hour}`, entry.count]),
		)
		const max = Math.max(1, ...cells.map((entry) => entry.count))
		const rows = weekdayRows.flatMap((weekday) =>
			Array.from({ length: 24 }, (_, hour) => {
				const count = counts.get(`${weekday}:${hour}`) ?? 0
				return {
					weekday,
					hour,
					count,
					paint:
						count > 0
							? softColor(color, 12 + Math.round((count / max) * 78))
							: chartEmptyFill,
				}
			}),
		)
		const paints = [...new Set(rows.map((row) => row.paint))]
		return defineChart({
			...xyChartDefaults,
			marks: [
				cell(rows, {
					x: 'hour',
					y: 'weekday',
					color: 'paint',
					radius: 3.5,
					inset: 1.5,
				}),
			],
			scales: {
				x: {
					scale: scaleBand<number>,
					domain: Array.from({ length: 24 }, (_, hour) => hour),
					axis: {
						ticks: {
							values: [0, 6, 12, 18],
							format: (hour) => `${String(hour).padStart(2, '0')}:00`,
						},
					},
				},
				y: {
					scale: scaleBand<number>,
					domain: [...weekdayRows],
					axis: {
						ticks: { format: (weekday) => weekdayLabels[weekday] ?? '' },
					},
				},
			},
			color: { scale: scaleOrdinal(paints, paints) },
			tooltip: {
				use: tooltip,
				content: (points, context) =>
					tooltipRows(
						points,
						context,
						(datum) => ({
							label: weekdayLabels[datum.weekday] ?? '',
							value: `${datum.count} ${unitLabel}`,
						}),
						`${String(points[0]?.datum.hour ?? 0).padStart(2, '0')}:00 UTC`,
					),
			},
		})
	}, [cells, color, unitLabel])
	return (
		<div css={chartScrollerCss}>
			<div css={{ minWidth: 580 }}>
				<Chart
					definition={definition}
					height={166}
					initialWidth={682}
					ariaLabel={ariaLabel}
				/>
			</div>
		</div>
	)
}
