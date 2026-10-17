import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { LandingPrimitives } from './components/landing-primitives.tsx'

test('primitives sentence pairs lantern orbs with words and ships empty leaders', async () => {
	const html = await renderToString(jsx(LandingPrimitives, {}))

	expect(html).toContain('id="primitives"')
	expect(html).toContain('href="/docs"')
	expect(html).toContain('>What is Kody?<')
	expect(html).not.toMatch(
		/<p class="landing-primitives-more">[\s\S]*href="\/features"/,
	)
	expect(html).toContain('kody-primitives-lantern-480.webp')
	expect(html).toContain('kody-primitives-lantern.webp 863w')
	expect(html).toContain('clip-path:polygon(')
	expect(html.indexOf('id="primitives-title"')).toBeLessThan(
		html.indexOf('landing-lantern'),
	)
	expect(html.indexOf('landing-primitives-words')).toBeLessThan(
		html.indexOf('What is Kody?'),
	)

	for (const { id, word, href } of [
		{ id: 'memory', word: 'memory', href: '/features/memory' },
		{ id: 'packages', word: 'packages', href: '/features/packages' },
		{ id: 'triggers', word: 'triggers', href: '/features/triggers' },
		{ id: 'integrations', word: 'credentials', href: '/features/credentials' },
		{ id: 'apps', word: 'apps', href: '/features/apps' },
	]) {
		expect(html).toContain(`href="${href}"`)
		expect(html).toContain(`>${word}<`)
		expect(html).toContain(`data-word="${id}"`)
		expect(html).toContain(`data-orb="${id}"`)
		expect(html).toContain(`data-orb-art="${id}"`)
		expect(html).toContain(`data-primitive="${id}"`)
		expect(html).toContain(`aria-label="${word} primitive"`)
		expect(html).toContain(`--primitive-color:var(--primitive-${id})`)
	}

	expect(html.match(/data-dot="/g)).toHaveLength(5)
	expect(html.match(/class="landing-leader"/g)).toHaveLength(5)
	// Paths are written from layout on the client; SSR paints nothing.
	expect(html).not.toMatch(/class="landing-leader-flow"[^>]*\sd="/)
})
