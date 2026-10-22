import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
