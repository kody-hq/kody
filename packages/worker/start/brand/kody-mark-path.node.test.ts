import { expect, test } from 'vitest'
import {
	kodyBrandAssets,
	kodyMarkAspectRatio,
	kodyMarkPathD,
	kodyMarkSvgMarkup,
	kodyMarkViewBox,
} from './kody-mark-path.ts'

test('mark path metadata stays evenodd and theme-downloadable', () => {
	expect(kodyMarkViewBox).toBe('220.727 325.009973 807.440627 593.242027')
	expect(kodyMarkPathD.startsWith('M0 0')).toBe(true)
	expect(kodyMarkAspectRatio).toBeGreaterThan(1.3)
	expect(kodyMarkAspectRatio).toBeLessThan(1.4)
	const svg = kodyMarkSvgMarkup('#000000')
	expect(svg).toContain('fill-rule="evenodd"')
	expect(svg).toContain('fill="#000000"')
	expect(kodyBrandAssets.guide).toBe('/brand-guide')
	expect(kodyBrandAssets.pngSolidLight).toContain('solid-light')
	expect(kodyBrandAssets.pngSolidDark).toContain('solid-dark')
})
