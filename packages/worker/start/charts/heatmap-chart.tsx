/** @jsxImportSource @emotion/react */

import {
	chartAxisTextCss,
	chartEmptyFill,
	chartScrollerCss,
	chartSvgCss,
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

const leftPad = 34
const topPad = 6
const cellWidth = 24
const cellHeight = 17
const cellGap = 3
const width = leftPad + 24 * (cellWidth + cellGap)
const height = topPad + 7 * (cellHeight + cellGap) + 20

/**
 * Weekday x hour activity heatmap (UTC) with intensity scaled to the
 * busiest cell.
 */
export function HeatmapChart(props: HeatmapChartProps) {
	const { cells, color, ariaLabel, unitLabel } = props
	const countByCell = new Map<string, number>()
	let maxCount = 0
	for (const cell of cells) {
		countByCell.set(`${cell.weekday}:${cell.hour}`, cell.count)
		maxCount = Math.max(maxCount, cell.count)
	}
	return (
		<div css={chartScrollerCss}>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				role="img"
				aria-label={ariaLabel}
				css={chartSvgCss(width)}
			>
				{weekdayRows.map((weekday, rowIndex) => (
					<text
						key={weekday}
						x={leftPad - 8}
						y={topPad + rowIndex * (cellHeight + cellGap) + cellHeight / 2 + 4}
						textAnchor="end"
						css={chartAxisTextCss}
					>
						{weekdayLabels[weekday]}
					</text>
				))}
				{Array.from({ length: 24 }, (_, hour) =>
					hour % 6 === 0 ? (
						<text
							key={hour}
							x={leftPad + hour * (cellWidth + cellGap) + cellWidth / 2}
							y={height - 4}
							textAnchor="middle"
							css={chartAxisTextCss}
						>
							{String(hour).padStart(2, '0')}:00
						</text>
					) : null,
				)}
				{weekdayRows.map((weekday, rowIndex) =>
					Array.from({ length: 24 }, (_, hour) => {
						const count = countByCell.get(`${weekday}:${hour}`) ?? 0
						const intensity =
							maxCount > 0 && count > 0
								? 12 + Math.round((count / maxCount) * 78)
								: 0
						return (
							<rect
								key={`${weekday}-${hour}`}
								x={leftPad + hour * (cellWidth + cellGap)}
								y={topPad + rowIndex * (cellHeight + cellGap)}
								width={cellWidth}
								height={cellHeight}
								rx="3.5"
								fill={
									intensity > 0 ? softColor(color, intensity) : chartEmptyFill
								}
							>
								<title>{`${weekdayLabels[weekday]} ${String(hour).padStart(2, '0')}:00 UTC — ${count} ${unitLabel}`}</title>
							</rect>
						)
					}),
				)}
			</svg>
		</div>
	)
}
