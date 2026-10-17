import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from './test-support/render-start-page.ts'
import { AdminOrgLimitsPanel } from './pages/admin-users-limits.tsx'
import { AdminUserDestinationPanel } from './pages/admin-users-destination-panel.tsx'
import { adminOrgLimitsQuery } from './admin-user-controls-query.ts'
import { limitOverrideKeys } from '#universal/plans.ts'

test('native limits panel renders plan/effective caps and editable overrides', async () => {
	const html = await renderStartPage(
		createElement(AdminOrgLimitsPanel, { orgId: 'org-a' }),
		'/admin/users',
		null,
		(client) =>
			client.setQueryData(adminOrgLimitsQuery(null, 'org-a').queryKey, {
				org: { id: 'org-a', slug: 'org-a', displayName: null },
				plan: 'free',
				creditWallet: 'none',
				seats: 1,
				limits: [
					{
						key: limitOverrideKeys[0],
						label: 'Daily cap',
						planLimit: 10,
						effectiveLimit: 20,
						override: {
							value: 20,
							active: true,
							expiresAt: null,
							reason: 'Support approval',
							setByUserId: 'admin-user',
							createdAt: '2026-10-13T00:00:00Z',
							updatedAt: '2026-10-13T00:00:00Z',
						},
					},
				],
			}),
	)
	for (const text of [
		'Limit overrides',
		'Org limits',
		'Daily cap',
		'Support approval',
		'Remove',
		'Set limit override',
		'Value (or',
		'Reason (required)',
		'Expires (optional)',
		'Save override',
	])
		expect(html).toContain(text)
})
test('native destination panel retains explicit ownership warning and email action', async () => {
	const html = await renderStartPage(
		createElement(AdminUserDestinationPanel, { stableUserId: 'user-a' }),
		'/admin/users',
	)
	expect(html).toContain('after the person proves they own it')
	expect(html).toContain('type="email"')
	expect(html).toContain('aria-label="Destination email"')
	expect(html).toContain('Mark destination verified')
})
