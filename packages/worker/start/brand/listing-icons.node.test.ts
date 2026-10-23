import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { expect, test } from 'vitest'

const publicDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../public',
)

test('ChatGPT / Codex app icon stays under the 10 KB upload cap', () => {
	const bytes = readFileSync(path.join(publicDir, 'images/kody-app-icon.png'))
	expect(bytes.byteLength).toBeGreaterThan(500)
	expect(bytes.byteLength).toBeLessThanOrEqual(10_000)
})

test('MCP and PWA chrome icons are opaque PNG tiles', () => {
	for (const file of [
		'android-chrome-192x192.png',
		'android-chrome-512x512.png',
		'apple-touch-icon.png',
		'logo.png',
	]) {
		const bytes = readFileSync(path.join(publicDir, file))
		expect(bytes.byteLength).toBeGreaterThan(500)
		// PNG signature
		expect([...bytes.subarray(0, 8)]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
	}
})

async function readPixels(file: string) {
	const bytes = readFileSync(path.join(publicDir, file))
	const { data, info } = await sharp(bytes)
		.ensureAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true })
	expect(info.width).toBe(info.height)
	return {
		size: info.width,
		pixel: (x: number, y: number) => {
			const offset = (y * info.width + x) * 4
			return [...data.subarray(offset, offset + 4)]
		},
	}
}

test('tab favicons are rounded tiles: outlined on white, solid on black', async () => {
	const tiles: Array<[file: string, plate: number]> = [
		['favicon-16x16.png', 255],
		['favicon-32x32.png', 255],
		['favicon-16x16-dark.png', 0],
		['favicon-32x32-dark.png', 0],
	]
	for (const [file, plate] of tiles) {
		const { size, pixel } = await readPixels(file)
		const last = size - 1
		const middle = Math.floor(size / 2)
		// Rounded corners: the very corner pixels are transparent.
		for (const [x, y] of [
			[0, 0],
			[last, 0],
			[0, last],
			[last, last],
		] as const) {
			expect({ file, x, y, alpha: pixel(x, y)[3] }).toEqual({
				file,
				x,
				y,
				alpha: 0,
			})
		}
		// Edge midpoints sit on the opaque plate.
		for (const [x, y] of [
			[middle, 0],
			[0, middle],
		] as const) {
			expect({ file, x, y, pixel: pixel(x, y) }).toEqual({
				file,
				x,
				y,
				pixel: [plate, plate, plate, 255],
			})
		}
		// The mark contrasts with the plate somewhere inside the tile.
		let strongest = 0
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				strongest = Math.max(strongest, Math.abs(pixel(x, y)[0]! - plate))
			}
		}
		expect({ file, inked: strongest > 200 }).toEqual({ file, inked: true })
	}
	// Light tiles use the outlined mark: the cheek beside the nose stays white
	// (the solid black mark would ink it).
	const light = await readPixels('favicon-32x32.png')
	expect(light.pixel(12, 21)).toEqual([255, 255, 255, 255])
})

test('home-screen icons are opaque outlined-on-white squares', async () => {
	for (const file of [
		'apple-touch-icon.png',
		'android-chrome-192x192.png',
		'android-chrome-512x512.png',
	]) {
		const { size, pixel } = await readPixels(file)
		const last = size - 1
		for (const [x, y] of [
			[0, 0],
			[last, last],
		] as const) {
			expect({ file, pixel: pixel(x, y) }).toEqual({
				file,
				pixel: [255, 255, 255, 255],
			})
		}
	}
})

test('svg favicon is a rounded tile that follows the OS color scheme', () => {
	const svg = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')
	expect(svg).toMatch(/<rect[^>]+rx="/)
	expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)/)
	expect(svg).toContain('clip-path=')
	expect(svg).toContain('fill-rule="evenodd"')
	const viewBox = svg
		.match(/viewBox="([^"]+)"/)?.[1]
		?.split(' ')
		.map(Number)
	expect(viewBox?.[2]).toBeCloseTo(viewBox?.[3] ?? 0, 5)
})
