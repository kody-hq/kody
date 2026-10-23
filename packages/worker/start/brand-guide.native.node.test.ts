import { expect, test } from 'vitest'
import { createElement as jsx } from 'react'
import { renderStartPage } from './test-support/render-start-page.ts'
import { BrandGuideRoute } from './pages/brand-guide.tsx'
import { kodyBrandAssets } from './brand/kody-mark-path.ts'

test('brand guide pairs light and dark previews with their downloads', async () => {
	const html = await renderStartPage(jsx(BrandGuideRoute, {}), '/brand-guide')
	expect(html).toContain('Brand guide')
	for (const href of [
		kodyBrandAssets.logoSvgOutlined,
		kodyBrandAssets.logoPngOutlined,
		kodyBrandAssets.logoSvgWhite,
		kodyBrandAssets.logoPngWhite,
		kodyBrandAssets.svgOutlined,
		kodyBrandAssets.pngOutlined,
		kodyBrandAssets.svgWhite,
		kodyBrandAssets.pngWhite,
		kodyBrandAssets.pngOutlinedSolidLight,
		kodyBrandAssets.pngSolidDark,
	]) {
		expect(html).toContain(`href="${href}"`)
	}
	expect(html).toContain('aria-label="Download light logo SVG"')
	expect(html).toContain('aria-label="Download dark mark PNG"')
	expect(html).toContain('aria-label="Download light app icon PNG"')
	// No light-mode solid black treatment is offered.
	expect(html).not.toContain(`href="${kodyBrandAssets.svg}"`)
	expect(html).not.toContain(kodyBrandAssets.pngBlack)
	expect(html).toContain('Do not distort')
	expect(html).not.toContain('—')
	const logoIndex = html.indexOf('id="logo-heading"')
	const markIndex = html.indexOf('id="mark-heading"')
	const iconIndex = html.indexOf('id="app-icon-heading"')
	expect(logoIndex).toBeGreaterThan(-1)
	expect(markIndex).toBeGreaterThan(logoIndex)
	expect(iconIndex).toBeGreaterThan(markIndex)
})
