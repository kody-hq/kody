import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	kodyMarkOutlinedLeftEyePathD,
	kodyMarkOutlinedNosePathD,
	kodyMarkOutlinedRightEyePathD,
	kodyMarkOutlinedRingPathD,
	kodyMarkOutlinedSvgMarkup,
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
