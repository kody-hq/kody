import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountPageHeader } from '../../pages/account-management-components.tsx'

test('detail headers keep their explicit section identity regardless of URL shape', async () => {
	const html = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Connection',
			description: '',
			currentHref: '/@team/-/integrations/apps/google',
			entity: 'integrations',
		}),
	)
	expect(html).toContain('data-entity-explainer="integrations"')
	expect(html).toContain('What is an integration?')
})
