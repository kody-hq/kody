import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { InternalErrorPage } from '../components/internal-error-page.tsx'

test('internal-error Try again stays same-origin for protocol-relative URLs', async () => {
	const html = await renderToString(
		jsx(InternalErrorPage, {}),
		'//evil.example',
	)

	expect(html).not.toContain('href="//evil.example"')
	expect(html).toContain('href="/"')
})
