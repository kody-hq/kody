import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	kodyBrandAssets,
	kodyMarkAspectRatio,
	kodyMarkLeftEyePathD,
	kodyMarkNosePathD,
	kodyMarkOutlinedSvgMarkup,
	kodyMarkOuterPathD,
	kodyMarkOutlineStrokeWidth,
	kodyMarkPathD,
	kodyMarkRightEyePathD,
	kodyMarkSvgMarkup,
	kodyMarkViewBox,
} from './kody-mark-path.ts'

const brandDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../public/images/brand',
)

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
	expect(kodyBrandAssets.svgOutlined).toContain('outlined')
	expect(kodyBrandAssets.pngOutlined).toContain('outlined')
	expect(kodyBrandAssets.pngOutlinedSolidLight).toContain(
		'outlined-solid-light',
	)
})

test('outlined mark splits the solid path and uses an inner stroke', () => {
	expect(kodyMarkOuterPathD.startsWith('M0 0')).toBe(true)
	expect(kodyMarkOuterPathD.endsWith('Z')).toBe(true)
	expect(kodyMarkPathD.startsWith(kodyMarkOuterPathD)).toBe(true)
	expect(kodyMarkLeftEyePathD.startsWith('M-9.054543')).toBe(true)
	expect(kodyMarkRightEyePathD.startsWith('M230.969703')).toBe(true)
	expect(kodyMarkNosePathD.startsWith('M94 338')).toBe(true)
	expect(kodyMarkOutlineStrokeWidth).toBe(15)
	const outlined = kodyMarkOutlinedSvgMarkup('#000000')
	expect(outlined).toContain('clipPath')
	expect(outlined).toContain(`stroke-width="${kodyMarkOutlineStrokeWidth * 2}"`)
	expect(outlined).toContain(kodyMarkOuterPathD)
	expect(outlined).toContain(kodyMarkNosePathD)
	expect(outlined).not.toContain('fill-rule="evenodd"')
})

test('published outlined SVG matches the markup helper', () => {
	const published = readFileSync(
		path.join(brandDir, 'kody-mark-outlined.svg'),
		'utf8',
	)
	expect(published).toBe(kodyMarkOutlinedSvgMarkup('#000000'))
})
