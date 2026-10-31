/** @jsxImportSource @emotion/react */
import { xyChartDefaults } from '../charts/xy-chart-defaults.ts'
import { tooltipRows } from '../charts/tooltip-content.ts'
import { useMemo } from 'react'
import { useRouter } from '@tanstack/react-router'
import { barX, barY, defineChart, stack } from '@tanstack/charts'
import { Chart } from '../charts/chart.tsx'
import { focusNearestY } from '@tanstack/charts/focus'
import { scaleBand } from '@tanstack/charts/scales/band'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { tooltip } from '@tanstack/charts/tooltip'
import { chartColor } from '#client/charts/chart-theme.ts'
import { type WorkspaceRunCharts } from '#universal/workspace-charts.ts'
import { formatOnCreditsMicroUsd } from '#universal/usage-presentation.ts'
import { SiteLink } from '../components/site-link.tsx'
import { colors } from '#universal/styles/tokens.ts'

const statusColors = {
	Success: chartColor.emerald,
	Error: chartColor.rose,
	Running: chartColor.blue,
}

export function ExecutionHistoryChart({
	days,
}: {
	days: WorkspaceRunCharts['days']
}) {
	const definition = useMemo(() => {
		const rows = days.flatMap((day) => [
			{ day: day.day, status: 'Success' as const, count: day.success },
			{ day: day.day, status: 'Error' as const, count: day.error },
			{ day: day.day, status: 'Running' as const, count: day.running },
		])
		const max = Math.max(
			1,
			...days.map((day) => day.success + day.error + day.running),
		)
		return defineChart({
			...xyChartDefaults,
			marks: [
				barY(rows, {
					x: 'day',
					y: 'count',
					z: 'status',
					key: (row) => `${row.day}:${row.status}`,
					fill: (row) => statusColors[row.status],
					layout: stack(),
					maxThickness: 36,
				}),
			],
			scales: {
				x: {
					scale: () => scaleBand<string>().padding(0.25),
					axis: { ticks: { format: (day) => day.slice(5).replace('-', '/') } },
				},
				y: {
					scale: scaleLinear,
					domain: [0, max],
					nice: true,
					grid: true,
					axis: {
						label: 'Runs',
						ticks: {
							values: countTicks(max),
							format: (value) => String(value),
						},
					},
				},
			},
			tooltip: {
				use: tooltip,
				content: (points, context) =>
					tooltipRows(
						points,
						context,
						(datum) => ({ label: datum.status, value: String(datum.count) }),
						points[0]?.datum.day,
					),
			},
		})
	}, [days])
	return (
		<>
			<Chart
				definition={definition}
				height={170}
				initialWidth={520}
				idPrefix="workspace-execution-history"
				ariaLabel="Daily top-level executions by outcome over the last seven UTC days"
			/>
			<details css={detailsCss}>
				<summary>Daily values</summary>
				<table>
					<thead>
						<tr>
							<th>Date (UTC)</th>
							<th>Success</th>
							<th>Error</th>
							<th>Running</th>
						</tr>
					</thead>
					<tbody>
						{days.map((day) => (
							<tr key={day.day}>
								<th>{day.day}</th>
								<td>{day.success}</td>
								<td>{day.error}</td>
								<td>{day.running}</td>
							</tr>
						))}
					</tbody>
				</table>
			</details>
		</>
	)
}

export type RankingRow = {
	key: string
	label: string
	value: number
	href: string
}
export function WorkspaceRankingChart({
	rows,
	currency = false,
	ariaLabel,
	id,
}: {
	rows: Array<RankingRow>
	currency?: boolean
	ariaLabel: string
	id: string
}) {
	const router = useRouter()
	const definition = useMemo(() => {
		const max = Math.max(currency ? 0.01 : 1, ...rows.map((row) => row.value))
		return defineChart({
			...xyChartDefaults,
			// Rows are categories on y; x-group focus could select another row.
			focus: focusNearestY,
			marks: [
				barX(rows, {
					x: 'value',
					y: 'key',
					key: 'key',
					fill: currency ? chartColor.violet : chartColor.blue,
					maxThickness: 22,
					radius: 3,
				}),
			],
			scales: {
				x: {
					scale: scaleLinear,
					domain: [0, max],
					nice: true,
					grid: true,
					axis: {
						label: currency ? 'Credits spent (USD)' : 'Runs',
						ticks: {
							...(currency ? { count: 3 } : { values: countTicks(max) }),
							format: (value) =>
								currency
									? formatOnCreditsMicroUsd(value * 1_000_000)
									: String(value),
						},
					},
				},
				y: {
					scale: () => scaleBand<string>().padding(0.35),
					domain: rows.map((row) => row.key),
					axis: {
						ticks: {
							format: (key) => {
								const label = rows.find((row) => row.key === key)?.label ?? key
								const limit = 18
								return label.length > limit
									? `${label.slice(0, limit - 1)}…`
									: label
							},
						},
					},
				},
			},
			tooltip: {
				use: tooltip,
				content: (points, context) =>
					tooltipRows(points, context, (datum) => ({
						label: datum.label,
						value: currency
							? formatOnCreditsMicroUsd(datum.value * 1_000_000)
							: datum.value.toLocaleString('en-US'),
					})),
			},
		})
	}, [rows, currency])
	return (
		<>
			<Chart
				definition={definition}
				height={Math.max(120, rows.length * 30 + 50)}
				initialWidth={420}
				idPrefix={id}
				ariaLabel={ariaLabel}
				onSelect={(point) => {
					if (point) void router.navigate({ href: point.datum.href })
				}}
			/>
			<details css={detailsCss}>
				<summary>Values and details</summary>
				<ul>
					{rows.map((row) => (
						<li key={row.key}>
							<SiteLink href={row.href}>{row.label}</SiteLink>:{' '}
							{currency
								? formatOnCreditsMicroUsd(row.value * 1_000_000)
								: row.value.toLocaleString('en-US')}
						</li>
					))}
				</ul>
			</details>
		</>
	)
}

const detailsCss = {
	fontSize: '0.75rem',
	color: colors.textMuted,
	marginTop: '0.5rem',
	'& summary': { cursor: 'pointer' },
	'& table': { width: '100%', textAlign: 'left' as const, marginTop: '0.5rem' },
	'& th, & td': { padding: '0.2rem' },
}

function countTicks(max: number) {
	const step = Math.max(1, Math.ceil(max / 4))
	return Array.from(
		{ length: Math.floor(max / step) + 1 },
		(_, index) => index * step,
	)
}
