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

test('tab favicons are solid, full-bleed tiles for light and dark OS chrome', async () => {
	const tiles: Array<[file: string, background: number]> = [
		['favicon-16x16.png', 255],
		['favicon-32x32.png', 255],
		['favicon-16x16-dark.png', 0],
		['favicon-32x32-dark.png', 0],
		['apple-touch-icon.png', 255],
		['android-chrome-192x192.png', 255],
		['android-chrome-512x512.png', 255],
	]
	for (const [file, background] of tiles) {
		const bytes = readFileSync(path.join(publicDir, file))
		const { data, info } = await sharp(bytes)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true })
		expect(info.width).toBe(info.height)
		const pixel = (x: number, y: number) => {
			const offset = (y * info.width + x) * 4
			return [...data.subarray(offset, offset + 4)]
		}
		const last = info.width - 1
		// Every corner is the opaque plate color: no transparent padding.
		for (const [x, y] of [
			[0, 0],
			[last, 0],
			[0, last],
			[last, last],
		] as const) {
			expect({ file, x, y, pixel: pixel(x, y) }).toEqual({
				file,
				x,
				y,
				pixel: [background, background, background, 255],
			})
		}
		// The mark spans the tile edge to edge: ink reaches the outer columns.
		const edgeInk = (fromLeft: boolean) => {
			let strongest = 0
			for (let step = 0; step < Math.ceil(info.width * 0.04); step += 1) {
				const x = fromLeft ? step : last - step
				for (let y = 0; y < info.height; y += 1) {
					strongest = Math.max(
						strongest,
						Math.abs(pixel(x, y)[0]! - background),
					)
				}
			}
			return strongest
		}
		const leftInk = edgeInk(true) > 24 ? 1 : 0
		const rightInk = edgeInk(false) > 24 ? 1 : 0
		expect({ file, leftInk: leftInk > 0, rightInk: rightInk > 0 }).toEqual({
			file,
			leftInk: true,
			rightInk: true,
		})
	}
})

test('svg favicon is a full-bleed tile that follows the OS color scheme', () => {
	const svg = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')
	expect(svg).toContain('<rect')
	expect(svg).toMatch(/@media \(prefers-color-scheme: dark\)/)
	const viewBox = svg
		.match(/viewBox="([^"]+)"/)?.[1]
		?.split(' ')
		.map(Number)
	expect(viewBox?.[2]).toBeCloseTo(viewBox?.[3] ?? 0, 5)
})
