import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { LandingPrimitiveCards } from './landing-primitive-cards.tsx'

test('homepage cards link each primitive and keep the widgets decorative', async () => {
	const html = await renderToString(jsx(LandingPrimitiveCards, {}))

	expect(html.match(/class="landing-pcard"/g)).toHaveLength(5)
	expect(html.match(/data-size="mini"/g)).toHaveLength(5)
	for (const page of [
		'memory',
		'packages',
		'triggers',
		'credentials',
		'apps',
	]) {
		expect(html).toContain(`href="/features/${page}"`)
	}
	expect(html).toContain('<em>Primitives</em> for your agents')
	expect(
		html.match(
			/<div[^>]*class="pw [^>]*aria-hidden="true"|<div[^>]*aria-hidden="true"[^>]*class="pw /g,
		),
	).toHaveLength(5)
	// The card is the link, so a mini scene has nothing else to focus.
	expect(html).not.toContain('<button')
	// Motion is client-only: the server sends the finished still.
	expect(html).not.toContain('data-motion')
	expect(html).toContain('href="/features"')
})
