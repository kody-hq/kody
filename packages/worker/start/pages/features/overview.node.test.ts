import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { FeaturesOverview } from './overview.tsx'

test('features overview shows the lantern and gives every primitive card an interactive widget', async () => {
	const html = await renderToString(jsx(FeaturesOverview, {}))

	// Five lantern orbs plus five cards.
	expect(html.match(/data-primitive="/g)).toHaveLength(10)
	expect(html.match(/class="pw pw-/g)).toHaveLength(5)
	expect(html).toContain('aria-label="The five primitives"')
	for (const id of ['memory', 'packages', 'triggers', 'integrations', 'apps']) {
		expect(html).toContain(`data-primitive="${id}"`)
	}
	for (const page of [
		'memory',
		'packages',
		'triggers',
		'credentials',
		'apps',
	]) {
		expect(html).toContain(`href="/features/${page}"`)
	}
	expect(html).not.toContain('href="/features/integrations"')
	expect(html).toContain('aria-pressed="true"')
	expect(html).toContain('aria-pressed="false"')
	expect(html).not.toContain('data-motion')
})
