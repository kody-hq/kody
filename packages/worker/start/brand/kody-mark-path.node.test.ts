import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	kodyMarkOutlinedSvgMarkup,
	kodyMarkSvgMarkup,
} from './kody-mark-path.ts'

const brandDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../public/images/brand',
)

test('published outlined SVG matches the markup helper', () => {
	const published = readFileSync(
		path.join(brandDir, 'kody-mark-outlined.svg'),
		'utf8',
	)
	expect(published).toBe(kodyMarkOutlinedSvgMarkup('#000000'))
	const publishedSolid = readFileSync(
		path.join(brandDir, 'kody-mark.svg'),
		'utf8',
	)
	expect(publishedSolid).toBe(kodyMarkSvgMarkup('#000000'))
})
