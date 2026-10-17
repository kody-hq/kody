import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { BelieveRoute } from './believe.tsx'

test('believe page ties each belief to a published doc', async () => {
	const html = await renderStartPage(jsx(BelieveRoute, {}), '/believe')

	expect(html).toContain('<h1>What we believe</h1>')
	expect(html).toContain('The best software is invisible.')
	expect(html).toContain('href="/"')

	const docLinks = [...html.matchAll(/href="(\/docs[^"]*)"/g)].map(
		(match) => match[1],
	)
	expect(docLinks).toEqual([
		'/docs',
		'/docs/connect-your-agent',
		'/docs/secrets',
		'/docs/triggers',
		'/docs/package-sharing',
	])
})
