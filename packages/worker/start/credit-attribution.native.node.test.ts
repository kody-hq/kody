import { createElement } from 'react'
import { expect, test } from 'vitest'
import { WhereItWentPanel } from './pages/account-usage-where-it-went.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import {
	type CreditAttributionRow,
	type CreditAttributionVisitorRow,
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

test('visitor usage reuses the account search, sort, and record table styles', async () => {
	const visitor: CreditAttributionVisitorRow = {
		displayName: 'Anonymous',
		creditsMicroUsd: 1_000_000,
		lastDay: '2026-10-16',
		meters: [
			{
				meter: 'unique_worker_days',
				label: 'Worker compute',
				units: 2,
				creditsMicroUsd: 1_000_000,
			},
		],
	}
	const html = await renderStartPage(
		createElement(WhereItWentPanel, {
			breakdown: {
				month: '2026-10',
				totalCreditsMicroUsd: 1_000_000,
				rows: [
					{
						...row,
						visitors: [visitor],
						visitorCount: 1,
						visitorsTruncated: false,
					},
				],
			},
		}),
	)

	expect(html).toContain('data-visitors-search')
	expect(html).toContain('data-field-ring')
	expect(html).toContain('aria-label="Visitors"')
	expect(html).toContain('text-transform:uppercase')
	expect(html).toContain('data-visitors-sort="credits"')
	expect(html).toContain('data-visitors-sort="username"')
	expect(html).toContain('Anonymous')
	expect(html).toContain('Showing')
	expect(html).toContain('visitors')
})

test('visitors from another org are marked as paid by their own org', async () => {
	const visitor: CreditAttributionVisitorRow = {
		displayName: 'outside-visitor',
		creditsMicroUsd: 0,
		lastDay: '2026-10-16',
		billedToVisitorOrg: true,
		meters: [
			{
				meter: 'durable_object_rows_read',
				label: 'Rows read',
				units: 40,
				creditsMicroUsd: 0,
				billedToVisitorOrg: true,
			},
		],
	}
	const html = await renderStartPage(
		createElement(WhereItWentPanel, {
			breakdown: {
				month: '2026-10',
				totalCreditsMicroUsd: 2_000_000,
				rows: [
					{
						...row,
						visitors: [visitor],
						visitorCount: 1,
						visitorsTruncated: false,
					},
				],
			},
		}),
	)
	expect(html).toContain('data-visitors-billed-elsewhere')
	expect(html).toContain('outside-visitor (their org pays)')
	expect(html).toContain('Rows read: 40 (their org paid)')
})
