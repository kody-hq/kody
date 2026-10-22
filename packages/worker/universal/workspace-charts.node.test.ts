import { expect, test } from 'vitest'
import {
	buildWorkspaceRunCharts,
	formatWorkspaceChartUtcDay,
	overviewExecutionTotals,
	workspaceChartWindow,
	workspaceChartsPartialSince,
} from './workspace-charts.ts'

test('overviewExecutionTotals sums chart bars for Overview tiles', () => {
	const charts = buildWorkspaceRunCharts(
		workspaceChartWindow(new Date('2026-10-22T12:00:00.000Z')),
		[
			{ day: '2026-10-20', surface: 'execute', status: 'success', count: 3 },
			{ day: '2026-10-20', surface: 'job', status: 'error', count: 1 },
			{ day: '2026-10-21', surface: 'execute', status: 'running', count: 2 },
		],
		'2026-10-20',
	)
	expect(overviewExecutionTotals(charts)).toEqual({ total: 6, running: 2 })
})

test('partial-since note only appears before durable counts cover the window', () => {
	const window = workspaceChartWindow(new Date('2026-10-22T12:00:00.000Z'))
	expect(
		workspaceChartsPartialSince(
			buildWorkspaceRunCharts(window, [], '2026-10-20'),
		),
	).toBe('2026-10-20')
	expect(
		workspaceChartsPartialSince(
			buildWorkspaceRunCharts(window, [], '2026-10-16'),
		),
	).toBeNull()
	expect(
		workspaceChartsPartialSince(buildWorkspaceRunCharts(window, [], null)),
	).toBeNull()
	expect(formatWorkspaceChartUtcDay('2026-10-20')).toBe('Oct 20, 2026')
})
