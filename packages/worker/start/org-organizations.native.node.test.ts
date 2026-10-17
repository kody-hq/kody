import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { OrganizationsPage } from './pages/org-organizations.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type AccountOrganizationsLoaderData } from '#universal/loader-data.ts'
test('native organizations shows recently deleted handles with restore actions', async () => {
	const data: AccountOrganizationsLoaderData = {
		ok: true,
		username: 'owner',
		viewer: { displayName: 'Owner', avatarUrl: null },
		organizations: [],
		pendingInvites: [],
		restorableOrganizations: [
			{
				slug: 'reserved-team',
				displayName: 'Reserved team',
				deletedAt: '2026-10-16T12:00:00.000Z',
			},
		],
	}
	const html = await renderStartPage(jsx(OrganizationsPage, { data }))
	expect(html).toContain('Recently deleted')
	expect(html).toContain('aria-label="Restore @reserved-team"')
	expect(html).toContain('data-testid="restore-organization"')
	expect(html).toContain('30 days after deletion')
	expect(html).toContain('Reserved team')
})
