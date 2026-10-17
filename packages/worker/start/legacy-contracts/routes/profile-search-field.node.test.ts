import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { ProfileRepositorySearchInput } from '../../components/profile-search-field.tsx'

test('profile repository search is an uncontrolled text searchbox named q', async () => {
	const html = await renderToString(
		jsx(ProfileRepositorySearchInput, {
			username: 'kody',
			filters: {
				query: 'notes',
				visibility: 'private',
				listing: 'all',
				hidden: 'all',
				app: 'all',
				package: 'all',
				sort: 'updated',
				dir: 'desc',
			},
		}),
	)

	expect(html).toContain('role="searchbox"')
	expect(html).toContain('name="q"')
	expect(html).toContain('data-testid="profile-repository-search"')
	expect(html).toContain('type="text"')
	expect(html).toContain('inputMode="search"')
	expect(html).toContain('value="notes"')
	expect(html).not.toContain('type="search"')
})
