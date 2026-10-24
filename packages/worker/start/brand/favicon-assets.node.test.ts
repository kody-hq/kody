import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { expect, test } from 'vitest'
import { kodyFaviconSvgMarkup } from './kody-mark-path.ts'

const publicDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../public',
)

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
			return [...data.subarray(offset, offset + 4)] as [
				number,
				number,
				number,
				number,
			]
		},
	}
}

test('published favicon.svg matches the markup helper and has no plate', () => {
	const published = readFileSync(path.join(publicDir, 'favicon.svg'), 'utf8')
	expect(published).toBe(kodyFaviconSvgMarkup())
	expect(published).not.toContain('<rect')
	expect(published).not.toMatch(/\bplate\b/)
	expect(published).toMatch(/@media \(prefers-color-scheme: dark\)/)
	expect(published).toContain('fill-rule="evenodd"')
	const viewBox = published
		.match(/viewBox="([^"]+)"/)?.[1]
		?.split(' ')
		.map(Number)
	expect(viewBox?.[2]).toBeCloseTo(viewBox?.[3] ?? 0, 5)
})

test('tab favicons are transparent and fill the square edge to edge', async () => {
	const tiles: Array<[file: string, inkChannel: 'dark' | 'light']> = [
		['favicon-16x16.png', 'dark'],
		['favicon-32x32.png', 'dark'],
		['favicon-16x16-dark.png', 'light'],
		['favicon-32x32-dark.png', 'light'],
	]
	for (const [file, ink] of tiles) {
		const { size, pixel } = await readPixels(file)
		const last = size - 1
		// Corners stay transparent: no opaque plate or rounded tile.
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
		// Wider mark: ink reaches the left and right outer columns.
		const edgeHasInk = (x: number) => {
			for (let y = 0; y < size; y += 1) {
				const [red, , , alpha] = pixel(x, y)
				if (alpha < 64) continue
				if (ink === 'dark' && red < 64) return true
				if (ink === 'light' && red > 192) return true
			}
			return false
		}
		expect({
			file,
			leftInk: edgeHasInk(0) || edgeHasInk(1),
			rightInk: edgeHasInk(last) || edgeHasInk(last - 1),
		}).toEqual({ file, leftInk: true, rightInk: true })
	}
})

test('favicon.ico embeds light PNG frames at 16, 32, and 48', () => {
	const ico = readFileSync(path.join(publicDir, 'favicon.ico'))
	expect(ico.readUInt16LE(0)).toBe(0)
	expect(ico.readUInt16LE(2)).toBe(1)
	const count = ico.readUInt16LE(4)
	expect(count).toBe(3)
	const sizes = new Set<number>()
	for (let i = 0; i < count; i += 1) {
		const dir = 6 + i * 16
		const width = ico[dir] === 0 ? 256 : ico[dir]!
		sizes.add(width)
		const byteSize = ico.readUInt32LE(dir + 8)
		const offset = ico.readUInt32LE(dir + 12)
		// PNG signature inside each ICO image blob.
		expect([...ico.subarray(offset, offset + 8)]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		])
		expect(byteSize).toBeGreaterThan(100)
	}
	expect([...sizes].sort((a, b) => a - b)).toEqual([16, 32, 48])
})
