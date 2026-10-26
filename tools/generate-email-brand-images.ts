/**
 * Regenerate the email header logo and footer mark from the brand SVGs.
 *
 * Most mail clients (Gmail, Outlook) do not render SVG, so emails load these
 * 2x PNGs instead. Each one bakes an opaque white rounded plate with padding
 * around the light-mode artwork, so the black ink stays readable when a
 * client darkens or inverts the email background in dark mode.
 *
 * Usage: `npx tsx tools/generate-email-brand-images.ts`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	emailFooterMark,
	emailHeaderLogo,
	type EmailBrandImage,
} from '../packages/worker/src/app/email/brand-images.ts'

const publicDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../packages/worker/public',
)

/** Render scale relative to the CSS size the email displays. */
const scale = 2
/** Supersample before downscaling for smoother edges. */
const supersample = 4

function readSvg(publicPath: string) {
	const source = readFileSync(path.join(publicDir, publicPath), 'utf8')
	const viewBox = source.match(/viewBox="([^"]+)"/)?.[1]
	const inner = source.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]
	if (!viewBox || !inner) {
		throw new Error(`Could not parse SVG at ${publicPath}`)
	}
	const [, , width, height] = viewBox.split(/\s+/).map(Number)
	return { viewBox, inner, aspect: width! / height! }
}

function plateSvgMarkup(image: EmailBrandImage) {
	const { viewBox, inner, aspect } = readSvg(image.sourceSvg)
	const width = image.width * supersample
	const height = image.height * supersample
	const radius = image.radius * supersample
	const artWidth = image.artWidth * supersample
	const artHeight = artWidth / aspect
	const x = (width - artWidth) / 2
	const y = (height - artHeight) / 2
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#ffffff"/>
  <svg x="${x}" y="${y}" width="${artWidth}" height="${artHeight}" viewBox="${viewBox}">${inner}</svg>
</svg>
`
}

async function renderPlate(image: EmailBrandImage) {
	const svg = Buffer.from(plateSvgMarkup(image), 'utf8')
	const bytes = await sharp(svg)
		.resize(image.width * scale, image.height * scale, { kernel: 'lanczos3' })
		.png({ compressionLevel: 9, palette: false })
		.toBuffer()
	writeFileSync(path.join(publicDir, image.src), bytes)
	console.log(
		`Wrote ${image.src} (${image.width * scale}x${image.height * scale})`,
	)
}

async function generateEmailBrandImages() {
	await renderPlate(emailHeaderLogo)
	await renderPlate(emailFooterMark)
}

if (isExecutedDirectly(import.meta.url)) {
	await generateEmailBrandImages()
}
