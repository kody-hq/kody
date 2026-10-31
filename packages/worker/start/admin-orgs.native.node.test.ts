import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { AdminOrgsPage } from './pages/admin-orgs.tsx'

test('organization list renders aggregate seat sync history without identifiers', async () => {
	const href = '/admin/orgs'
	const report = {
		syncs: {
			since: '2026-01-01T00:00:00.000Z',
			events: 3,
			orgs: 2,
			changes: [
				{ previousQuantity: 1, nextQuantity: 3, orgs: 2 },
				{ previousQuantity: 2, nextQuantity: 1, orgs: 1 },
			],
		},
	}
	const html = await renderStartPage(
		createElement(AdminOrgsPage, {
			payload: { items: [], total: 0, page: 1, pageSize: 25 },
			currentHref: href,
			status: 'live',
			kind: 'all',
			query: '',
		}),
		href,
		null,
		(client) => {
			client.setQueryData(['admin-org-seat-sync', href], report)
		},
	)
	expect(html).toContain('Seat sync')
	expect(html).toContain(
		'Stripe seat quantity changes from the last 30 days, in aggregate. No organization names are shown.',
	)
	expect(html).toContain('Old → new seats')
	expect(html).toContain('1 → 3')
	expect(html).toContain('2')
	expect(html).toContain('Compare with Stripe')
	expect(html).not.toContain('fixture-org')
	const organizationsTableIndex = html.indexOf('aria-label="Organizations"')
	const seatSyncPanelIndex = html.indexOf('Seat sync')
	expect(organizationsTableIndex).toBeGreaterThanOrEqual(0)
	expect(organizationsTableIndex).toBeLessThan(seatSyncPanelIndex)
})
