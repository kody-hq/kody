import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { NotFoundPage } from '../components/not-found-page.tsx'

test('not-found page shows the disappointed illustration and recovery destinations', async () => {
	const html = await renderToString(jsx(NotFoundPage, {}))

	expect(html).toContain('data-testid="not-found-page"')
	expect(html).toContain('href="/"')
	expect(html).toContain('href="/docs"')
	expect(html).toContain('href="/community"')
	expect(html).toContain('data-error-agent-prompt')
})
