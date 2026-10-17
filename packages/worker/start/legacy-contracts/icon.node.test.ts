const iconicGlyphViewBox = '3.75 3.75 16.5 16.5'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { renderIcon } from '../components/icon.tsx'

test('Iconic icons crop padded viewBoxes and stay decorative unless titled', async () => {
	const decorative = await renderToString(renderIcon('home', { size: '16' }))
	expect(decorative).toContain(`viewBox="${iconicGlyphViewBox}"`)
	expect(decorative).toContain('data-icon="home"')
	expect(decorative).toContain('aria-hidden="true"')
	expect(decorative).not.toContain('aria-label')
	expect(decorative).toContain('stroke="currentColor"')
	expect(decorative).not.toMatch(/<svg[^>]*\bstroke=/)
	expect(decorative).toContain('width="16"')

	const labelled = await renderToString(
		renderIcon('search', { title: 'Search files' }),
	)
	expect(labelled).toContain('aria-label="Search files"')
	expect(labelled).toContain('role="img"')
	expect(labelled).not.toContain('aria-hidden')

	const helper = await renderToString(renderIcon('mail'))
	expect(helper).toContain('data-icon="mail"')
	expect(helper).toContain('aria-hidden="true"')

	const fillOnly = await renderToString(renderIcon('dots-horizontal'))
	expect(fillOnly).toContain('fill="currentColor"')
	expect(fillOnly).not.toMatch(/<svg[^>]*\bstroke=/)
})

test('every Iconic glyph name has a cropped currentColor stroke', async () => {
	const { iconNames } = await import('#universal/icon-names.ts')
	for (const name of iconNames) {
		const html = await renderToString(renderIcon(name))
		expect(html).toContain(`data-icon="${name}"`)
		expect(html).toContain(`viewBox="${iconicGlyphViewBox}"`)
		expect(html).toContain('aria-hidden="true"')
		expect(html).not.toMatch(/<svg[^>]*\bstroke=/)
		expect(
			html.includes('stroke="currentColor"') ||
				html.includes('fill="currentColor"'),
		).toBe(true)
	}
})
