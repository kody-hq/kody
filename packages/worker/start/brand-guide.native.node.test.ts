import { expect, test } from 'vitest'
import { createElement as jsx } from 'react'
import { renderStartPage } from './test-support/render-start-page.ts'
import { BrandGuideRoute } from './pages/brand-guide.tsx'
import { kodyBrandAssets } from './brand/kody-mark-path.ts'

test('brand guide shows solid downloads first, then SVG and transparent PNGs', async () => {
	const html = await renderStartPage(jsx(BrandGuideRoute, {}), '/brand-guide')
	expect(html).toContain('Brand guide')
	expect(html).toContain('Solid backgrounds')
	expect(html).toContain(kodyBrandAssets.pngOutlinedSolidLight)
	expect(html).toContain(kodyBrandAssets.pngSolidDark)
	expect(html).toContain('Download PNG: outlined black on white')
	expect(html).toContain('Download PNG: solid white on black')
	expect(html).toContain(kodyBrandAssets.svgOutlined)
	expect(html).toContain(kodyBrandAssets.svg)
	expect(html).toContain(kodyBrandAssets.svgWhite)
	expect(html).toContain('Download SVG (outlined, for light backgrounds)')
	expect(html).toContain('Download SVG (solid black)')
	expect(html).toContain('Download SVG (solid white, for dark backgrounds)')
	expect(html).toContain(kodyBrandAssets.pngOutlined)
	expect(html).toContain(kodyBrandAssets.pngBlack)
	expect(html).toContain(kodyBrandAssets.pngWhite)
	expect(html).toContain('Light: outlined mark (for light backgrounds)')
	expect(html).toContain('Dark: solid mark (for dark backgrounds)')
	expect(html).toContain('Do not distort')
	expect(html).not.toContain('—')
	const solidIndex = html.indexOf('Solid backgrounds')
	const transparentIndex = html.indexOf('SVG and transparent PNG')
	expect(solidIndex).toBeGreaterThan(-1)
	expect(transparentIndex).toBeGreaterThan(solidIndex)
})
