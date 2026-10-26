/**
 * Regenerate browser-tab favicons from the mark path helpers:
 * transparent edge-to-edge SVG, light/dark PNGs, and a multi-size ICO.
 *
 * Usage: `npx tsx tools/generate-tab-favicons.ts`
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
	kodyFaviconRasterSvgMarkup,
	kodyFaviconSvgMarkup,
} from '../packages/worker/start/brand/kody-mark-path.ts'
import { isExecutedDirectly } from './node-runtime.ts'

const publicDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../packages/worker/public',
)

function packPngIco(pngs: Array<{ size: number; bytes: Buffer }>): Buffer {
	const count = pngs.length
	const headerSize = 6 + count * 16
	let offset = headerSize
	const entries: Array<{ size: number; bytes: Buffer; offset: number }> = []
	for (const png of pngs) {
		entries.push({ ...png, offset })
		offset += png.bytes.byteLength
	}
	const out = Buffer.alloc(offset)
	out.writeUInt16LE(0, 0) // reserved
	out.writeUInt16LE(1, 2) // type: icon
	out.writeUInt16LE(count, 4)
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i]!
		const dir = 6 + i * 16
		out[dir] = entry.size >= 256 ? 0 : entry.size
		out[dir + 1] = entry.size >= 256 ? 0 : entry.size
		out[dir + 2] = 0 // color count
		out[dir + 3] = 0 // reserved
		out.writeUInt16LE(1, dir + 4) // planes
		out.writeUInt16LE(32, dir + 6) // bit count
		out.writeUInt32LE(entry.bytes.byteLength, dir + 8)
		out.writeUInt32LE(entry.offset, dir + 12)
		entry.bytes.copy(out, entry.offset)
	}
	return out
}

async function rasterize(
	theme: 'light' | 'dark',
	size: number,
): Promise<Buffer> {
	const svg = Buffer.from(kodyFaviconRasterSvgMarkup(theme), 'utf8')
	return sharp(svg, { density: 384 })
		.resize(size, size, {
			fit: 'fill',
			background: { r: 0, g: 0, b: 0, alpha: 0 },
		})
		.png()
		.toBuffer()
}

async function main() {
	writeFileSync(path.join(publicDir, 'favicon.svg'), kodyFaviconSvgMarkup())

	const light16 = await rasterize('light', 16)
	const light32 = await rasterize('light', 32)
	const light48 = await rasterize('light', 48)
	const dark16 = await rasterize('dark', 16)
	const dark32 = await rasterize('dark', 32)

	writeFileSync(path.join(publicDir, 'favicon-16x16.png'), light16)
	writeFileSync(path.join(publicDir, 'favicon-32x32.png'), light32)
	writeFileSync(path.join(publicDir, 'favicon-16x16-dark.png'), dark16)
	writeFileSync(path.join(publicDir, 'favicon-32x32-dark.png'), dark32)
	writeFileSync(
		path.join(publicDir, 'favicon.ico'),
		packPngIco([
			{ size: 16, bytes: light16 },
			{ size: 32, bytes: light32 },
			{ size: 48, bytes: light48 },
		]),
	)

	console.log('Wrote favicon.svg, favicon-*.png, favicon.ico')
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
