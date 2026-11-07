import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { WorkspaceAppsEmptyState } from './workspace-apps-empty-state.tsx'
import { AccountPageHeader } from '../pages/account-management-components.tsx'

test('workspace apps empty state explains apps and offers a copyable agent prompt', async () => {
	const html = await renderToString(
		jsx(WorkspaceAppsEmptyState, { orgSlug: 'jane' }),
	)
	expect(html).toContain('data-testid="workspace-apps-empty"')
	expect(html).toContain('No apps in this workspace yet')
	expect(html).toContain('dashboards and tools')
	expect(html).toContain('Copy a prompt for my agent')
	expect(html).toContain('Explore apps you can fork')
	expect(html).toContain('/community?category=apps&amp;org=jane')
	expect(html).toContain('dashboard is a good first win')
})

test('apps page header mounts the entity explainer popover', async () => {
	const html = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Apps',
			currentHref: '/@jane/-/apps',
			entity: 'apps',
		}),
	)
	expect(html).toContain('data-entity-explainer="apps"')
	expect(html).toContain('What is an app?')
	expect(html).toContain('data-entity-explainer-trigger="apps"')
})
