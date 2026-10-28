import { createElement } from 'react'
import { expect, test } from 'vitest'
import { WorkspaceCharts } from './pages/workspace-charts.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import {
	buildWorkspaceRunCharts,
	workspaceChartWindow,
} from '#universal/workspace-charts.ts'

const window = workspaceChartWindow(new Date('2026-01-03T12:00:00Z'))
const charts = buildWorkspaceRunCharts(
	window,
	[{ day: '2025-12-31', surface: 'job', status: 'error', count: 4 }],
	'2025-12-30',
)

test('chart window fills missing UTC days across a year boundary', () => {
	expect(charts.days.map((day) => day.day)).toEqual([
		'2025-12-28',
		'2025-12-29',
		'2025-12-30',
		'2025-12-31',
		'2026-01-01',
		'2026-01-02',
		'2026-01-03',
	])
	expect(charts.days[3]?.error).toBe(4)
	expect(charts.sources).toEqual([{ surface: 'job', count: 4 }])
	expect(charts.countsSince).toBe('2025-12-30')
})

test('charts hide billing when access is unavailable and link execution sources', async () => {
	const html = await renderStartPage(
		createElement(WorkspaceCharts, { charts, billing: null, base: '/@jane/-' }),
	)
	expect(html).toContain('Execution history')
	expect(html).toContain('surface=job')
	expect(html).toContain('Showing runs since Dec 30, 2025.')
	expect(html).not.toContain('Credits spent by package')
})

test('spend chart preserves sub-cent charges and renders truthful over-include meters', async () => {
	const html = await renderStartPage(
		createElement(WorkspaceCharts, {
			charts,
			base: '/@jane/-',
			billing: {
				whereItWent: {
					month: '2026-01',
					totalCreditsMicroUsd: 5000,
					rows: [
						{
							packageId: 'pkg',
							name: 'Daily sync',
							href: '/@jane/sync',
							creditsMicroUsd: 5000,
							share: 1,
							meters: [],
							cumulative: [],
							isAdHoc: false,
						},
					],
				},
				includedCompute: [
					{
						resource: 'unique_worker_days',
						label: 'Worker compute',
						unitLabel: 'worker days',
						current: 120,
						include: 100,
						informational: false,
						barPercent: 100,
						pastInclude: true,
						tone: 'attention',
						status: '20 beyond include',
						onCreditsMicroUsd: 5000,
					},
				],
				creditsAlarm: null,
			},
		}),
	)
	expect(html).toContain('Daily sync')
	expect(html).toContain('$0.005')
	expect(html).toContain('href="/@jane/sync"')
	expect(html).toContain('aria-valuenow="120"')
	expect(html).toContain('120 used, 100 included')
	expect(html).not.toContain('No credits spent')
})

test('empty stacked charts render an empty state instead of invalid scales', async () => {
	const { StackedBarChart } = await import('./charts/stacked-bar-chart.tsx')
	for (const input of [
		{ series: [], xLabels: ['10-01', '10-02'] },
		{ series: [{ label: 'Reads', color: '#123456', values: [] }], xLabels: [] },
	]) {
		const html = await renderStartPage(
			createElement(StackedBarChart, {
				id: 'empty-reads',
				ariaLabel: 'Daily reads',
				...input,
			}),
		)
		expect(html).toContain('Daily reads: no activity')
		expect(html).toContain('No activity in this period.')
		expect(html).not.toContain('<svg')
	}
})
