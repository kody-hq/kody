import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { PackagesFeature } from '../../../pages/features/packages.tsx'

test('packages workbench keeps example source available without JavaScript', async () => {
	const html = await renderToString(jsx(PackagesFeature, {}))

	expect(html).toContain('id="package-source-fallback"')
	expect(html).toMatch(
		/<noscript>[\s\S]*README\.md[\s\S]*src\/brief\.ts[\s\S]*<\/noscript>/,
	)
})
