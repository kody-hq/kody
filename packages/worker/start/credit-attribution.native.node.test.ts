import { createElement } from 'react'
import { expect, test } from 'vitest'
import { WhereItWentPanel } from './pages/account-usage-where-it-went.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type CreditAttributionRow } from '#universal/credit-attribution.ts'
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
test('usage attribution preserves package share and ad hoc credits', async () => {
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
	expect(html).toContain('Worker compute:')
	expect(html).toContain('50%')
	expect(html).toContain('href="/@ada/report"')
	expect(html).toContain('data-where-it-went-row="adhoc"')
})
