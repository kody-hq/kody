import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	kodyFaviconSvgMarkup,
	kodyMarkOutlinedLeftEyePathD,
	kodyMarkOutlinedNosePathD,
	kodyMarkOutlinedOuterPathD,
	kodyMarkOutlinedRightEyePathD,
	kodyMarkOutlinedRingPathD,
	kodyMarkOutlinedSvgMarkup,
	kodyMarkPathTransform,
	kodyMarkSvgMarkup,
} from './kody-mark-path.ts'

const brandDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../public/images/brand',
)

test('published mark SVGs match the markup helper', () => {
	const published = readFileSync(
		path.join(brandDir, 'kody-mark-outlined.svg'),
		'utf8',
	)
	expect(published).toBe(kodyMarkOutlinedSvgMarkup('#000000'))
	const publishedSolid = readFileSync(
		path.join(brandDir, 'kody-mark-white.svg'),
		'utf8',
	)
	expect(publishedSolid).toBe(kodyMarkSvgMarkup('#ffffff'))
})

test('outlined mark is filled paths, not stroke-and-clip', () => {
	const outlined = kodyMarkOutlinedSvgMarkup('#000000')
	expect(outlined).toContain(kodyMarkOutlinedRingPathD)
	expect(outlined).toContain(kodyMarkOutlinedLeftEyePathD)
	expect(outlined).toContain(kodyMarkOutlinedRightEyePathD)
	expect(outlined).toContain(kodyMarkOutlinedNosePathD)
	expect(outlined).toContain('fill-rule="evenodd"')
	expect(outlined).not.toContain('clipPath')
	expect(outlined).not.toContain('stroke=')
	expect(outlined).not.toContain('stroke-width')
})

test('tab favicon markup is transparent edge-to-edge with scheme swap', () => {
	const favicon = kodyFaviconSvgMarkup()
	expect(favicon).toContain(kodyMarkOutlinedOuterPathD)
	expect(favicon).toContain(kodyMarkOutlinedRingPathD)
	expect(favicon).toContain('fill="#ffffff"')
	expect(favicon).toMatch(/@media \(prefers-color-scheme: dark\)/)
	expect(favicon).not.toContain('<rect')
	// Light group: white face under black outline (outer fill before ring).
	const lightGroup = favicon.match(/<g class="light">([\s\S]*?)<\/g>/)?.[1]
	expect(lightGroup).toBeTruthy()
	const whiteOuter = lightGroup!.indexOf(
		`fill="#ffffff" transform="${kodyMarkPathTransform}" d="${kodyMarkOutlinedOuterPathD}"`,
	)
	const blackRing = lightGroup!.indexOf(kodyMarkOutlinedRingPathD)
	expect(whiteOuter).toBeGreaterThanOrEqual(0)
	expect(blackRing).toBeGreaterThan(whiteOuter)
})
