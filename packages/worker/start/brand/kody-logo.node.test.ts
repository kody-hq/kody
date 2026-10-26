import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	kodyLogoAspectRatio,
	kodyLogoOutlinedSvgMarkup,
	kodyLogoSvgMarkup,
	kodyLogoViewBox,
	kodyWordmarkPathD,
} from './kody-logo.ts'
import {
	kodyBrandAssets,
	kodyMarkOutlinedRingPathD,
	kodyMarkPathD,
} from './kody-mark-path.ts'

const publicDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../public',
)

function readPublic(assetPath: string) {
	return readFileSync(path.join(publicDir, assetPath))
}

test('logo markup pairs the mark with the outlined wordmark', () => {
	const solid = kodyLogoSvgMarkup('#ffffff')
	expect(solid).toContain(`viewBox="${kodyLogoViewBox}"`)
	expect(solid).toContain(kodyMarkPathD)
	expect(solid).toContain(kodyWordmarkPathD)
	expect(solid).not.toContain('<text')
	expect(solid.match(/fill="#ffffff"/g)).toHaveLength(2)

	const outlined = kodyLogoOutlinedSvgMarkup('#000000')
	expect(outlined).not.toContain('clipPath')
	expect(outlined).toContain(kodyMarkOutlinedRingPathD)
	expect(outlined).toContain(kodyWordmarkPathD)
	expect(outlined).toContain('fill-rule="evenodd"')
	expect(outlined).not.toContain('stroke=')
})

test('published logo SVGs match the markup helpers', () => {
	expect(readPublic(kodyBrandAssets.logoSvgWhite).toString('utf8')).toBe(
		kodyLogoSvgMarkup('#ffffff'),
	)
	expect(readPublic(kodyBrandAssets.logoSvgOutlined).toString('utf8')).toBe(
		kodyLogoOutlinedSvgMarkup('#000000'),
	)
})

test('logo PNGs are 2048px wide at the logo aspect ratio', () => {
	for (const assetPath of [
		kodyBrandAssets.logoPngWhite,
		kodyBrandAssets.logoPngOutlined,
	]) {
		const png = readPublic(assetPath)
		const width = png.readUInt32BE(16)
		const height = png.readUInt32BE(20)
		expect(width).toBe(2048)
		expect(height).toBe(Math.round(2048 / kodyLogoAspectRatio))
	}
})
