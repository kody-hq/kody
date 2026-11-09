import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import {
	createOgFrame,
	ensureRenderPipelineReady,
	renderOgImage,
	truncateOgText,
	type OgAssetsFetcher,
	type SatoriElement,
} from '#worker/og/render.ts'

const TITLE_MAX_LENGTH = 70
const DESCRIPTION_MAX_LENGTH = 180
const BLOG_AUTHOR = 'Kent C. Dodds'

export type BlogPostOgImageInput = {
	/** Card palette; defaults to `OG_DEFAULT_THEME`. */
	theme?: OgTheme
	title: string
	description: string
	date: string
	/** Category label shown beside "Blog" in the card's eyebrow. */
	category?: string | null
	/** Optional Satori-safe PNG/JPEG data URI composed on the right. */
	imageDataUri?: string
}

function createBlogPostOgMarkup(input: BlogPostOgImageInput): SatoriElement {
	const palette = getOgPalette(input.theme)
	const title = {
		type: 'div',
		props: {
			style: {
				fontFamily: 'Bricolage Grotesque',
				fontSize: input.imageDataUri ? 60 : 52,
				fontWeight: 700,
				lineHeight: input.imageDataUri ? 1.05 : 1.2,
				letterSpacing: input.imageDataUri ? '-0.025em' : '-0.02em',
				marginBottom: 24,
				color: palette.text,
			},
			children: truncateOgText(input.title, TITLE_MAX_LENGTH),
		},
	} satisfies SatoriElement
	const description = {
		type: 'div',
		props: {
			style: {
				fontSize: 28,
				lineHeight: input.imageDataUri ? 1.38 : 1.4,
				color: input.imageDataUri ? palette.textReading : palette.textMuted,
				marginBottom: 32,
			},
			children: truncateOgText(input.description, DESCRIPTION_MAX_LENGTH),
		},
	} satisfies SatoriElement
	const byline = {
		type: 'div',
		props: {
			style: {
				display: 'flex',
				fontSize: 22,
				color: palette.textMuted,
			},
			children: `${input.date} · ${BLOG_AUTHOR}`,
		},
	} satisfies SatoriElement

	if (!input.imageDataUri) {
		return createOgFrame({
			theme: input.theme,
			label: input.category ? `Blog · ${input.category}` : 'Blog',
			children: [title, description, byline],
		})
	}

	return createOgFrame({
		theme: input.theme,
		label: input.category ? `Blog · ${input.category}` : 'Blog',
		children: {
			type: 'div',
			props: {
				style: {
					width: '100%',
					height: '100%',
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 48,
				},
				children: [
					{
						type: 'div',
						props: {
							style: {
								width: 610,
								display: 'flex',
								flexDirection: 'column',
							},
							children: [title, description, byline],
						},
					},
					{
						type: 'img',
						props: {
							src: input.imageDataUri,
							width: 430,
							height: 430,
							style: {
								width: 430,
								height: 430,
								objectFit: 'cover',
								borderRadius: 28,
								border: `2px solid ${palette.border}`,
							},
						},
					},
				],
			},
		},
	})
}

export async function renderBlogPostOgImage(
	input: BlogPostOgImageInput & { assets?: OgAssetsFetcher },
): Promise<Uint8Array<ArrayBuffer>> {
	await ensureRenderPipelineReady({ assets: input.assets })
	return renderOgImage(createBlogPostOgMarkup(input), {
		assets: input.assets,
	})
}
