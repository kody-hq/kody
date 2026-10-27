import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { AreaChart } from './area-chart.tsx'
import { StackedBarChart } from './stacked-bar-chart.tsx'
import { DonutChart } from './donut-chart.tsx'
import { HeatmapChart } from './heatmap-chart.tsx'
import { FunnelChart } from './funnel-chart.tsx'
import { StatCard } from './stat-card.tsx'

for (const Component of [AreaChart, StackedBarChart]) {
	test(`${Component.name} renders empty, single, and multiple values without invalid geometry`, () => {
		for (const values of [[], [0], [4], [0, 4, 2]]) {
			const html = renderToStaticMarkup(
				createElement(Component, {
					id: 'test',
					ariaLabel: 'Usage history',
					xLabels: values.map((_, i) => `Day ${i}`),
					series: [
						{ label: 'Compute', color: '#123456', values },
						{ label: 'Storage', color: '#654321', values },
					],
				}),
			)
			expect(html).toContain('Usage history')
			expect(html).not.toMatch(/NaN|Infinity/)
			if (values.some(Boolean)) expect(html).toContain('#123456')
		}
	})
}

test('donuts retain totals, shares, and empty states', () => {
	for (const values of [[], [0], [4], [3, 1]]) {
		const html = renderToStaticMarkup(
			createElement(DonutChart, {
				slices: values.map((value, i) => ({
					label: `Slice ${i}`,
					value,
					color: '#123456',
				})),
				centerLabel: 'Runs',
				ariaLabel: 'Run outcomes',
			}),
		)
		expect(html).not.toMatch(/NaN|Infinity/)
		expect(html).toContain('Run outcomes')
		if (values.some(Boolean)) {
			expect(html).toContain('#123456')
			expect(html).toContain(values.length === 1 ? '100%' : '75%')
		} else expect(html).toContain('No data yet.')
	}
})

test('heatmap includes every UTC hour and weekday even with sparse data', () => {
	const html = renderToStaticMarkup(
		createElement(HeatmapChart, {
			cells: [{ weekday: 1, hour: 0, count: 4 }],
			color: '#123456',
			ariaLabel: 'Activity',
			unitLabel: 'events',
		}),
	)
	expect(html).not.toMatch(/NaN|Infinity/)
	expect(html).toContain('Mon')
	expect(html).toContain('Sun')
	expect(html).toContain('18:00')
	expect(html).toContain('#123456')
})

test('sparklines handle a flat zero series', () => {
	const html = renderToStaticMarkup(
		createElement(StatCard, {
			id: 'runs',
			label: 'Runs',
			value: '0',
			color: '#123456',
			sparkValues: [0, 0],
		}),
	)
	expect(html).not.toMatch(/NaN|Infinity/)
	expect(html).toContain('#123456')
})

test('activation funnels retain counts and signup shares', () => {
	const html = renderToStaticMarkup(
		createElement(FunnelChart, {
			ariaLabel: 'Activation',
			steps: [
				{ key: 'signup', label: 'Signed up', users: 4000, color: '#123456' },
				{ key: 'active', label: 'Activated', users: 1000, color: '#654321' },
			],
		}),
	)
	expect(html).toContain('25% of signups')
	expect(html).toContain('Activated: 1,000 users')
	expect(html).not.toMatch(/NaN|Infinity/)
})

test('area charts and card sparklines keep smooth curves and fading fills', () => {
	const values = [1, 4, 2, 8, 3, 5, 6]
	for (const chart of [
		createElement(AreaChart, {
			id: 'area-parity',
			ariaLabel: 'Usage',
			xLabels: values.map(String),
			series: [{ label: 'Compute', color: '#123456', values }],
		}),
		createElement(StatCard, {
			id: 'spark-parity',
			label: 'Runs',
			value: '29',
			color: '#123456',
			sparkValues: values,
		}),
	]) {
		const html = renderToStaticMarkup(chart)
		expect(html).toContain('<linearGradient')
		expect(html).toMatch(/<stop[^>]*offset="100%"[^>]*stop-opacity="0"/)
		expect(html).toMatch(/<path[^>]*d="[^"]*C/)
		expect(html).toMatch(/fill="url\(#[^)]+\)"[^>]*fill-opacity="1"/)
		expect(html).toContain('<circle')
	}
})
