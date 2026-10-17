import { Resvg } from '@resvg/resvg-wasm'
import satori, { init as initSatori } from 'satori/standalone'
import { createElement, type ReactNode } from 'react'
import { loadAdditionalOgAsset } from '#worker/og/og-emoji.ts'
import {
	ensureOgBinaryAssetsReady,
	getBricolageGrotesqueLatin700FontData,
	getKodyLogoDataUri,
	getKodyPatternDataUri,
	getWixMadeforTextLatin400FontData,
	ogYogaWasm,
	type OgAssetsFetcher,
} from '#worker/og/og-image-assets.ts'
import { ensureResvgWasmReady } from '#worker/og/resvg-wasm-init.ts'
import {
	getOgPalette,
	type OgTheme,
	OG_DEFAULT_THEME,
} from '#worker/og/palette.ts'

export type { OgAssetsFetcher } from '#worker/og/og-image-assets.ts'

export const OG_WIDTH = 1200
export const OG_HEIGHT = 630

export type SatoriChild = string | SatoriElement
export type SatoriElement = {
	type: string
	props: {
		style?: Record<string, string | number>
		children?: SatoriChild | Array<SatoriChild>
		src?: string
		width?: number
		height?: number
		viewBox?: string
		d?: string
		fill?: string
		stroke?: string
		strokeWidth?: number
		strokeLinecap?: 'butt' | 'round' | 'square'
		strokeOpacity?: number
		opacity?: number
		cx?: number
		cy?: number
		r?: number
	}
}

function renderSatoriChild(child: SatoriChild): ReactNode {
	if (typeof child === 'string') return child
	const { children, ...props } = child.props
	const descendants =
		children === undefined
			? []
			: Array.isArray(children)
				? children
				: [children]
	return createElement(child.type, props, ...descendants.map(renderSatoriChild))
}

let wasmReady: Promise<void> | null = null

export function ensureOgWasmReady(): Promise<void> {
	if (!wasmReady) {
		wasmReady = Promise.all([initSatori(ogYogaWasm), ensureResvgWasmReady()])
			.then(() => undefined)
			.catch((error) => {
				wasmReady = null
				throw error
			})
	}
	return wasmReady
}

export async function ensureRenderPipelineReady(input?: {
	assets?: OgAssetsFetcher
}): Promise<void> {
	await Promise.all([
		ensureOgWasmReady(),
		ensureOgBinaryAssetsReady({ assets: input?.assets }),
	])
}

/**
 * Clamp card copy to a character budget, breaking on a word boundary so an
 * excerpt reads as a trailing-off sentence rather than a severed word
 * ("no m…"). Falls back to a hard cut when a single word exceeds the budget,
 * which is the only case where mid-word is the lesser evil.
 *
 * Intentional `\n` line breaks are preserved (collapsed per line); callers that
 * need hard breaks in Satori should split on `\n` and render one node per line.
 */
export function truncateOgText(text: string, maxLength: number): string {
	const lines = text
		.trim()
		.split('\n')
		.map((line) => line.replace(/\s+/g, ' ').trim())
		.filter((line) => line.length > 0)
	if (lines.length === 0) {
		return ''
	}
	if (lines.length === 1) {
		return truncateOgLine(lines[0]!, maxLength)
	}
	// Keep the author-supplied breaks; budget is spent across the joined copy
	// so a long second line cannot silently balloon past the card limit.
	const joined = lines.join('\n')
	if (joined.length <= maxLength) {
		return joined
	}
	const truncated: string[] = []
	let remaining = maxLength
	for (const [index, line] of lines.entries()) {
		if (remaining <= 1) break
		const piece = truncateOgLine(line, remaining)
		truncated.push(piece)
		remaining -= piece.length
		if (index < lines.length - 1) remaining -= 1 // account for the `\n`
	}
	return truncated.join('\n')
}

function truncateOgLine(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text
	}
	const clipped = text.slice(0, maxLength - 1)
	const lastSpace = clipped.lastIndexOf(' ')
	// Only honour the boundary if it keeps most of the budget; otherwise a long
	// first word would collapse the line to almost nothing.
	const body =
		lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped
	return `${body.trimEnd().replace(/[,;:.]$/, '')}…`
}

/**
 * Shared 1200×630 frame for all Kody OG images: the app ground with the shirt
 * pattern fanning in from the right, a header row with the Kody wordmark, then
 * the page-specific content filling the rest.
 *
 * `theme` picks the palette and the matching pattern asset; it defaults to
 * `OG_DEFAULT_THEME`, so callers that do not care keep the current look.
 *
 * The canvas *is* the card — a social crawler already presents this image
 * inside its own rounded, bordered container, so drawing a second panel here
 * only reads as a card floating inside a card.
 *
 * `label` is the optional short line opposite the wordmark, for a section name
 * ("Blog", "Public package"). Omit it rather than restating the host: the
 * wordmark already says whose page this is.
 */
export function createOgFrame(input: {
	label?: string
	theme?: OgTheme
	children: SatoriChild | Array<SatoriChild>
}): SatoriElement {
	const theme = input.theme ?? OG_DEFAULT_THEME
	const palette = getOgPalette(theme)
	return {
		type: 'div',
		props: {
			style: {
				width: OG_WIDTH,
				height: OG_HEIGHT,
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: palette.background,
				padding: '40px 52px',
				fontFamily: 'Wix Madefor Text',
				color: palette.text,
				position: 'relative',
			},
			children: [
				// Shirt fabric, bled off the right and bottom edges so it reads as
				// ground rather than a placed image. First in source order because
				// Satori has no `z-index` — later siblings paint on top.
				{
					type: 'img',
					props: {
						src: getKodyPatternDataUri(theme),
						width: 700,
						height: 700,
						style: {
							position: 'absolute',
							right: -52,
							bottom: -52,
							width: 700,
							height: 700,
						},
					},
				},
				// Absolutely positioned so it takes no vertical space: the title
				// and description below centre on the whole 630px canvas, and a
				// header in the flow would push that centre down by its own height.
				{
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							top: 40,
							left: 52,
							right: 52,
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
						},
						children: [
							{
								type: 'div',
								props: {
									style: {
										display: 'flex',
										alignItems: 'center',
									},
									children: [
										{
											type: 'img',
											props: {
												src: getKodyLogoDataUri(),
												width: 64,
												height: 64,
												style: {
													width: 64,
													height: 64,
													marginRight: 16,
												},
											},
										},
										{
											type: 'div',
											props: {
												style: {
													fontFamily: 'Bricolage Grotesque',
													fontSize: 46,
													fontWeight: 700,
													letterSpacing: '-0.01em',
													// Matches `brandCss` in site-header.tsx: display
													// face at text colour, not the accent. Green is
													// reserved for one loud thing per surface.
													color: palette.text,
												},
												children: 'Kody',
											},
										},
									],
								},
							},
							...(input.label
								? [
										{
											type: 'div',
											props: {
												style: {
													fontSize: 20,
													color: palette.textMuted,
												},
												children: input.label,
											},
										},
									]
								: []),
						],
					},
				},
				{
					type: 'div',
					props: {
						style: {
							display: 'flex',
							flex: 1,
							flexDirection: 'column',
							justifyContent: 'center',
							position: 'relative',
							// No `overflow: hidden` — art is allowed to rise past the
							// content box into the header band. Clipping here cropped
							// the top of the mascot.
						},
						children: input.children,
					},
				},
			],
		},
	}
}

/**
 * Render a Satori markup tree to PNG bytes with the app's shared font set:
 * Wix Madefor Text 400 for body copy and Bricolage Grotesque 700/opsz 96 for
 * headings and the wordmark.
 */
export async function renderOgImage(
	markup: SatoriElement,
	input?: { assets?: OgAssetsFetcher },
): Promise<Uint8Array<ArrayBuffer>> {
	await ensureRenderPipelineReady({ assets: input?.assets })

	const bodyFontData = getWixMadeforTextLatin400FontData()
	const displayFontData = getBricolageGrotesqueLatin700FontData()
	const svg = await satori(renderSatoriChild(markup), {
		width: OG_WIDTH,
		height: OG_HEIGHT,
		// Latin fonts have no color-emoji glyphs. Twemoji images fill the gap
		// the same way epic-camp-tickets does: satori asks for each grapheme
		// via `loadAdditionalAsset` and we return a data URI.
		loadAdditionalAsset: loadAdditionalOgAsset,
		fonts: [
			{
				name: 'Wix Madefor Text',
				data: bodyFontData,
				weight: 400,
				style: 'normal',
			},
			{
				name: 'Bricolage Grotesque',
				data: displayFontData,
				weight: 700,
				style: 'normal',
			},
		],
	})

	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: OG_WIDTH },
		font: {
			fontBuffers: [
				new Uint8Array(bodyFontData),
				new Uint8Array(displayFontData),
			],
			defaultFontFamily: 'Wix Madefor Text',
			sansSerifFamily: 'Wix Madefor Text',
		},
	})
	const rendered = resvg.render()
	const png = rendered.asPng()
	rendered.free()
	resvg.free()

	// asPng returns a fresh ArrayBuffer-backed copy; narrow the generic so
	// callers can pass the bytes straight to Response as BodyInit.
	return png as Uint8Array<ArrayBuffer>
}
