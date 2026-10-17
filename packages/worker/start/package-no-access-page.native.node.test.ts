import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { PackageNoAccessPage } from './components/package-no-access-page.tsx'

test('package no-access page names the package and offers a request-access copy', async () => {
	const html = await renderToString(
		jsx(PackageNoAccessPage, {
			username: 'kody',
			kodyId: 'mau-chart',
			packageName: '@kody/mau-chart',
			viewerUsername: 'tannerlinsley',
		}),
	)

	expect(html).toContain('data-testid="package-no-access-page"')
	expect(html).toContain('You don&#x27;t have access')
	expect(html).toContain('@kody/mau-chart')
	expect(html).toContain('@<!-- -->tannerlinsley')
	expect(html).toContain('app:execute')
	expect(html).toContain('hosted app')
	expect(html).toContain('href="/docs/package-sharing"')
	expect(html).toContain('Copy access request')
	expect(html).toContain('data-error-agent-prompt')
})
