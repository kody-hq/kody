import { createElement } from 'react'
import { expect, test } from 'vitest'
import {
	WhereItWentPanel,
	PackageCreditAttributionPanel,
} from './pages/account-usage-where-it-went.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import {
	creditAttributionDefaultVisiblePackages,
	type CreditAttributionRow,
} from '#universal/credit-attribution.ts'
const row: CreditAttributionRow = {
	packageId: 'pkg',
	name: 'Daily report',
	href: '/@ada/report',
	creditsMicroUsd: 2000000,
	share: 0.5,
	meters: [
		{
			meter: 'unique_worker_days',
			label: 'Worker compute',
			creditsMicroUsd: 2000000,
		},
	],
	cumulative: [{ day: '2026-10-01', creditsMicroUsd: 2000000 }],
	isAdHoc: false,
}
test('usage attribution keeps package meters and ad hoc details available', async () => {
	const html = await renderStartPage(
		createElement(WhereItWentPanel, {
			breakdown: {
				month: '2026-10',
				totalCreditsMicroUsd: 4000000,
				rows: [
					row,
					{ ...row, packageId: '', name: 'Ad hoc', isAdHoc: true, href: null },
				],
			},
		}),
	)
	expect(html).toContain('Where it went')
	expect(html).toContain('Worker compute:')
	expect(html).toContain('50%')
	expect(html).toContain('href="/@ada/report"')
	expect(html).toContain('Cumulative Ad hoc credits across the period')
})
test('usage attribution limits initial packages and keeps ad hoc visible', async () => {
	const rows = Array.from(
		{ length: creditAttributionDefaultVisiblePackages + 1 },
		(_, index) => ({ ...row, packageId: `pkg-${index}` }),
	)
	const html = await renderStartPage(
		createElement(WhereItWentPanel, {
			breakdown: {
				month: '2026-10',
				totalCreditsMicroUsd: 1,
				rows: [
					...rows,
					{ ...row, packageId: '', name: 'Ad hoc', isAdHoc: true },
				],
			},
		}),
	)
	expect(html.match(/data-where-it-went-row=/g)).toHaveLength(
		creditAttributionDefaultVisiblePackages + 1,
	)
	expect(html).toContain('data-where-it-went-show-all')
	expect(html).toContain('data-where-it-went-row="adhoc"')
})
test('empty attribution and package details preserve their distinct views', async () => {
	expect(
		await renderStartPage(
			createElement(WhereItWentPanel, {
				breakdown: { month: '2026-10', totalCreditsMicroUsd: 0, rows: [] },
			}),
		),
	).toContain('No past-include credits this period.')
	const html = await renderStartPage(
		createElement(PackageCreditAttributionPanel, { row }),
	)
	expect(html).toContain('Credits this period')
	expect(html).toContain(
		'Cumulative credits for Daily report across the period',
	)
})
