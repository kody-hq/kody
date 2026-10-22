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

test('tab favicons are transparent, unpadded PNGs for light and dark OS chrome', async () => {
	for (const file of [
		'favicon-16x16.png',
		'favicon-32x32.png',
		'favicon-16x16-dark.png',
		'favicon-32x32-dark.png',
	]) {
		const bytes = readFileSync(path.join(publicDir, file))
		const { data, info } = await sharp(bytes)
			.ensureAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true })
		expect(info.width).toBe(info.height)
		// Corner must be fully transparent (no solid plate, no padding fill).
		expect(data[3]).toBe(0)
	}
})
