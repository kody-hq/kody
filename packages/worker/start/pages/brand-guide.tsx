/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { publicAsset } from '../public-assets.ts'
import { KodyMark } from '../components/kody-mark.tsx'
import { kodyBrandAssets } from '../brand/kody-mark-path.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'

/**
 * Public brand guide: mark treatments, downloads, and simple usage rules.
 */
export function BrandGuideRoute() {
	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={pageTitleCss}>Brand guide</h1>
				<p css={pageDescriptionCss}>
					The Kody mark is a koala head. On light surfaces use the outlined
					line-art mark (black). On dark surfaces use the solid mark (white). Do
					not recolor beyond those two treatments.
				</p>
			</header>

			<section aria-labelledby="solid-downloads-heading" css={sectionCss}>
				<h2 id="solid-downloads-heading" css={sectionTitleCss}>
					Solid backgrounds
				</h2>
				<p css={descriptionCss}>
					Fully opaque 4096×4096 squares for places where light and dark mode
					cannot be controlled (plugin directories, OAuth consent screens,
					slides, docs, chat avatars, social posts). Prefer solid black-on-white
					for marketplace and app-icon uploads. Prefer the outlined-on-white
					plate when you want the light-mode line-art look on a fixed white
					square.
				</p>
				<div css={previewGridCss}>
					<figure css={previewCardCss}>
						<div css={[previewStageCss, previewLightCss]}>
							<img
								src={publicAsset(kodyBrandAssets.pngSolidLight)}
								alt="Solid black Kody mark on a white square"
								width={280}
								height={280}
								css={solidPreviewImgCss}
							/>
						</div>
						<figcaption>
							<a
								href={publicAsset(kodyBrandAssets.pngSolidLight)}
								download="kody-mark-solid-light.png"
							>
								Download PNG: solid black on white
							</a>
							<span>4096×4096, opaque. Best for dark-ink app icons.</span>
						</figcaption>
					</figure>
					<figure css={previewCardCss}>
						<div css={[previewStageCss, previewLightCss]}>
							<img
								src={publicAsset(kodyBrandAssets.pngOutlinedSolidLight)}
								alt="Outlined black Kody mark on a white square"
								width={280}
								height={280}
								css={solidPreviewImgCss}
							/>
						</div>
						<figcaption>
							<a
								href={publicAsset(kodyBrandAssets.pngOutlinedSolidLight)}
								download="kody-mark-outlined-solid-light.png"
							>
								Download PNG: outlined black on white
							</a>
							<span>
								4096×4096, opaque. Light-mode line-art on a white plate.
							</span>
						</figcaption>
					</figure>
					<figure css={previewCardCss}>
						<div css={[previewStageCss, previewDarkCss]}>
							<img
								src={publicAsset(kodyBrandAssets.pngSolidDark)}
								alt="Solid white Kody mark on a black square"
								width={280}
								height={280}
								css={solidPreviewImgCss}
							/>
						</div>
						<figcaption>
							<a
								href={publicAsset(kodyBrandAssets.pngSolidDark)}
								download="kody-mark-solid-dark.png"
							>
								Download PNG: solid white on black
							</a>
							<span>4096×4096, opaque. For dark surfaces without a theme.</span>
						</figcaption>
					</figure>
				</div>
			</section>

			<section aria-labelledby="mark-preview-heading" css={sectionCss}>
				<h2 id="mark-preview-heading" css={sectionTitleCss}>
					Theme-aware mark
				</h2>
				<p css={descriptionCss}>
					Inline UI follows the page theme: outlined black on light backgrounds,
					solid white on dark. Prefer the transparent downloads when you control
					the background.
				</p>
				<div css={previewGridCss}>
					<figure css={previewCardCss}>
						<div css={[previewStageCss, previewLightCss]}>
							<span css={previewMarkCss}>
								<KodyMark size={160} variant="outlined" title="Kody" />
							</span>
						</div>
						<figcaption>
							Light: outlined mark (for light backgrounds)
						</figcaption>
					</figure>
					<figure css={previewCardCss}>
						<div css={[previewStageCss, previewDarkCss]}>
							<span css={[previewMarkCss, previewMarkOnDarkCss]}>
								<KodyMark size={160} variant="solid" title="Kody" />
							</span>
						</div>
						<figcaption>Dark: solid mark (for dark backgrounds)</figcaption>
					</figure>
				</div>
			</section>

			<section aria-labelledby="downloads-heading" css={sectionCss}>
				<h2 id="downloads-heading" css={sectionTitleCss}>
					SVG and transparent PNG
				</h2>
				<p css={descriptionCss}>
					SVG is the source of truth. Transparent PNGs are 2048px wide for
					compositing onto your own backgrounds.
				</p>
				<ul css={downloadListCss}>
					<li>
						<a
							href={publicAsset(kodyBrandAssets.svgOutlined)}
							download="kody-mark-outlined.svg"
						>
							Download SVG (outlined, for light backgrounds)
						</a>
						<span>Black line-art outline with solid eyes and nose</span>
					</li>
					<li>
						<a href={publicAsset(kodyBrandAssets.svg)} download="kody-mark.svg">
							Download SVG (solid black)
						</a>
						<span>Solid evenodd path; same geometry as the dark mark</span>
					</li>
					<li>
						<a
							href={publicAsset(kodyBrandAssets.svgWhite)}
							download="kody-mark-white.svg"
						>
							Download SVG (solid white, for dark backgrounds)
						</a>
						<span>White solid mark for dark surfaces</span>
					</li>
					<li>
						<a
							href={publicAsset(kodyBrandAssets.pngOutlined)}
							download="kody-mark-outlined.png"
						>
							Download PNG (transparent / outlined)
						</a>
						<span>2048×1505, transparent. For light backgrounds.</span>
					</li>
					<li>
						<a
							href={publicAsset(kodyBrandAssets.pngBlack)}
							download="kody-mark-black.png"
						>
							Download PNG (transparent / solid black)
						</a>
						<span>2048×1505, transparent</span>
					</li>
					<li>
						<a
							href={publicAsset(kodyBrandAssets.pngWhite)}
							download="kody-mark-white.png"
						>
							Download PNG (transparent / solid white)
						</a>
						<span>2048×1505, transparent. For dark backgrounds.</span>
					</li>
				</ul>
			</section>

			<section aria-labelledby="usage-heading" css={sectionCss}>
				<h2 id="usage-heading" css={sectionTitleCss}>
					Usage
				</h2>
				<ul css={usageListCss}>
					<li>
						<strong>Clear space.</strong> Keep empty space around the mark at
						least a quarter of its height on every side. The solid downloads
						already include comfortable padding.
					</li>
					<li>
						<strong>Do not distort.</strong> Scale proportionally. Do not
						stretch, skew, rotate into a lockup, or crop the ears or snout.
					</li>
					<li>
						<strong>Color.</strong> Outlined black on light backgrounds, solid
						white on dark backgrounds. Do not recolor beyond those two values,
						add gradients, or place the mark on busy photos without a solid
						scrim.
					</li>
					<li>
						<strong>Wordmark.</strong> When pairing with the word “Kody”, keep
						the mark to the left and optically aligned to the wordmark’s cap
						height.
					</li>
				</ul>
			</section>
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	gap: spacing['2xl'],
}

const sectionCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
}

const sectionTitleCss: CSSObject = {
	margin: 0,
	fontFamily: typography.fontFamilyDisplay,
	fontSize: typography.fontSize.xl,
	fontWeight: typography.fontWeight.bold,
	letterSpacing: '-0.02em',
	color: colors.text,
}

const previewGridCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
	gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
}

const previewCardCss: CSSObject = {
	margin: 0,
	display: 'grid',
	gap: spacing.sm,
	'& > figcaption': {
		display: 'grid',
		gap: '0.2rem',
		color: colors.textMuted,
		fontSize: typography.fontSize.sm,
	},
	'& > figcaption a': {
		color: colors.primaryText,
		fontWeight: typography.fontWeight.semibold,
		textDecoration: 'none',
		fontSize: typography.fontSize.base,
	},
	'& > figcaption a:hover': { textDecoration: 'underline' },
}

const previewStageCss: CSSObject = {
	display: 'grid',
	placeItems: 'center',
	minHeight: '18rem',
	padding: spacing.xl,
	borderRadius: radius.lg,
	border: `1px solid ${colors.border}`,
}

const previewLightCss: CSSObject = {
	background: '#f4f5f6',
	color: '#000000',
}

const previewDarkCss: CSSObject = {
	background: '#111417',
	borderColor: '#2a2f34',
	color: '#ffffff',
}

const previewMarkCss: CSSObject = {
	color: '#000000',
	display: 'inline-flex',
}

const previewMarkOnDarkCss: CSSObject = {
	color: '#ffffff',
}

const solidPreviewImgCss: CSSObject = {
	display: 'block',
	width: 'min(100%, 17.5rem)',
	height: 'auto',
	borderRadius: radius.md,
}

const downloadListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
	'& > li': {
		display: 'flex',
		flexWrap: 'wrap' as const,
		alignItems: 'baseline',
		gap: `0.35rem ${spacing.md}`,
		padding: `${spacing.sm} 0`,
		borderBottom: `1px solid ${colors.border}`,
	},
	'& a': {
		color: colors.primaryText,
		fontWeight: typography.fontWeight.semibold,
		textDecoration: 'none',
	},
	'& a:hover': { textDecoration: 'underline' },
	'& span': {
		color: colors.textMuted,
		fontSize: typography.fontSize.sm,
	},
}

const usageListCss: CSSObject = {
	margin: 0,
	paddingInlineStart: '1.2rem',
	display: 'grid',
	gap: spacing.sm,
	color: colors.text,
	lineHeight: 1.55,
	'& strong': { fontWeight: typography.fontWeight.semibold },
}
