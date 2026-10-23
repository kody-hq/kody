/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { publicAsset } from '../public-assets.ts'
import { kodyBrandAssets } from '../brand/kody-mark-path.ts'
import { colors, radius, transitions } from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageEyebrowCss,
	pageGutter,
	pageHeadCss,
} from '#universal/styles/style-primitives.ts'

type PlateTone = 'light' | 'dark'

type BrandFile = {
	format: 'SVG' | 'PNG'
	href: string
	filename: string
	label: string
}

type BrandPreview = {
	tone: PlateTone
	caption: string
	preview: string
	alt: string
	files: Array<BrandFile>
}

type BrandSection = {
	id: string
	title: string
	note: string
	shape: 'logo' | 'mark' | 'tile'
	previews: [BrandPreview, BrandPreview]
}

const brandSections: Array<BrandSection> = [
	{
		id: 'logo',
		title: 'Logo',
		note: 'The mark with the “Kody” wordmark. PNGs are 2048px wide and transparent.',
		shape: 'logo',
		previews: [
			{
				tone: 'light',
				caption: 'Light',
				preview: kodyBrandAssets.logoSvgOutlined,
				alt: 'Kody logo: outlined mark and black wordmark',
				files: [
					{
						format: 'SVG',
						href: kodyBrandAssets.logoSvgOutlined,
						filename: 'kody-logo-outlined.svg',
						label: 'Download light logo SVG',
					},
					{
						format: 'PNG',
						href: kodyBrandAssets.logoPngOutlined,
						filename: 'kody-logo-outlined.png',
						label: 'Download light logo PNG',
					},
				],
			},
			{
				tone: 'dark',
				caption: 'Dark',
				preview: kodyBrandAssets.logoSvgWhite,
				alt: 'Kody logo: solid white mark and wordmark',
				files: [
					{
						format: 'SVG',
						href: kodyBrandAssets.logoSvgWhite,
						filename: 'kody-logo-white.svg',
						label: 'Download dark logo SVG',
					},
					{
						format: 'PNG',
						href: kodyBrandAssets.logoPngWhite,
						filename: 'kody-logo-white.png',
						label: 'Download dark logo PNG',
					},
				],
			},
		],
	},
	{
		id: 'mark',
		title: 'Mark',
		note: 'The koala on its own, for tight spaces. PNGs are 2048px wide and transparent.',
		shape: 'mark',
		previews: [
			{
				tone: 'light',
				caption: 'Light',
				preview: kodyBrandAssets.svgOutlined,
				alt: 'Outlined black Kody mark',
				files: [
					{
						format: 'SVG',
						href: kodyBrandAssets.svgOutlined,
						filename: 'kody-mark-outlined.svg',
						label: 'Download light mark SVG',
					},
					{
						format: 'PNG',
						href: kodyBrandAssets.pngOutlined,
						filename: 'kody-mark-outlined.png',
						label: 'Download light mark PNG',
					},
				],
			},
			{
				tone: 'dark',
				caption: 'Dark',
				preview: kodyBrandAssets.svgWhite,
				alt: 'Solid white Kody mark',
				files: [
					{
						format: 'SVG',
						href: kodyBrandAssets.svgWhite,
						filename: 'kody-mark-white.svg',
						label: 'Download dark mark SVG',
					},
					{
						format: 'PNG',
						href: kodyBrandAssets.pngWhite,
						filename: 'kody-mark-white.png',
						label: 'Download dark mark PNG',
					},
				],
			},
		],
	},
	{
		id: 'app-icon',
		title: 'App icon',
		note: 'Opaque 4096px squares for avatars, app stores, and anywhere the theme is unknown.',
		shape: 'tile',
		previews: [
			{
				tone: 'light',
				caption: 'Light',
				preview: kodyBrandAssets.pngOutlinedSolidLight,
				alt: 'Outlined black Kody mark on a white square',
				files: [
					{
						format: 'PNG',
						href: kodyBrandAssets.pngOutlinedSolidLight,
						filename: 'kody-mark-outlined-solid-light.png',
						label: 'Download light app icon PNG',
					},
				],
			},
			{
				tone: 'dark',
				caption: 'Dark',
				preview: kodyBrandAssets.pngSolidDark,
				alt: 'Solid white Kody mark on a black square',
				files: [
					{
						format: 'PNG',
						href: kodyBrandAssets.pngSolidDark,
						filename: 'kody-mark-solid-dark.png',
						label: 'Download dark app icon PNG',
					},
				],
			},
		],
	},
]

const usageRules = [
	{
		title: 'Two treatments.',
		body: 'Outlined black on light, solid white on dark. No other colors or gradients.',
	},
	{
		title: 'Give it room.',
		body: 'Keep clear space of a quarter of the mark’s height on every side.',
	},
	{
		title: 'Do not distort.',
		body: 'Scale proportionally. No stretching, skewing, rotating, or cropping.',
	},
	{
		title: 'Use the files.',
		body: 'Use the logo files rather than setting “Kody” next to the mark yourself.',
	},
]

/**
 * Public brand guide: one light/dark pair per asset, with downloads tucked
 * into each preview, and a few usage rules.
 */
export function BrandGuideRoute() {
	return (
		<article css={pageCss}>
			<header css={headCss}>
				<div css={eyebrowCss}>Brand guide</div>
				<h1>
					One koala.
					<br />
					<em>Two</em> treatments.
				</h1>
				<p>
					Outlined black on light surfaces. Solid white on dark. Hover a preview
					to download it.
				</p>
			</header>

			{brandSections.map((section) => (
				<section
					key={section.id}
					aria-labelledby={`${section.id}-heading`}
					css={sectionCss}
				>
					<header css={sectionHeadCss}>
						<h2 id={`${section.id}-heading`}>{section.title}</h2>
						<p>{section.note}</p>
					</header>
					<div css={[splitCss, splitShapeCss[section.shape]]}>
						{section.previews.map((preview) => (
							<figure
								key={preview.tone}
								css={[plateCss, plateShapeCss[section.shape]]}
								data-tone={preview.tone}
							>
								<img
									src={publicAsset(preview.preview)}
									alt={preview.alt}
									loading="lazy"
								/>
								<figcaption>{preview.caption}</figcaption>
								<div css={downloadsCss}>
									{preview.files.map((file) => (
										<a
											key={file.href}
											href={publicAsset(file.href)}
											download={file.filename}
											aria-label={file.label}
											css={downloadCss}
										>
											<span aria-hidden="true">↓</span> {file.format}
										</a>
									))}
								</div>
							</figure>
						))}
					</div>
				</section>
			))}

			<section aria-labelledby="usage-heading" css={sectionCss}>
				<header css={sectionHeadCss}>
					<h2 id="usage-heading">Usage</h2>
				</header>
				<ul css={usageListCss}>
					{usageRules.map((rule) => (
						<li key={rule.title}>
							<strong>{rule.title}</strong> {rule.body}
						</li>
					))}
				</ul>
			</section>
		</article>
	)
}

/* The route owns its gutters: the app shell leaves `gutters: 'page'` routes
   unpadded. */
const pageCss: CSSObject = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(3rem, 7vw, 5.5rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
	display: 'grid',
	gap: 'clamp(3rem, 7vw, 5rem)',
}

const headCss: CSSObject = {
	...pageHeadCss,
	'& > p': {
		...pageHeadCss['& > p'],
		maxWidth: '44ch',
	},
}

const eyebrowCss: CSSObject = {
	...pageEyebrowCss,
	marginBottom: '1rem',
}

const sectionCss: CSSObject = {
	display: 'grid',
	gap: '1.25rem',
}

const sectionHeadCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'baseline',
	justifyContent: 'space-between',
	gap: '0.35rem 2rem',
	'& h2': {
		margin: 0,
		fontSize: 'clamp(1.4rem, 2.6vw, 1.8rem)',
		fontWeight: 720,
		letterSpacing: '-0.02em',
		lineHeight: 1.1,
	},
	'& p': {
		margin: 0,
		color: colors.textMuted,
		fontSize: '0.95rem',
		maxWidth: '52ch',
		textWrap: 'pretty',
	},
}

const splitCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	overflow: 'hidden',
	'@media (max-width: 640px)': {
		gridTemplateColumns: '1fr',
	},
}

/* App icons are their own squares, so they sit side by side as separate
   tiles instead of halves of one frame. */
const splitShapeCss: Record<BrandSection['shape'], CSSObject> = {
	logo: {},
	mark: {},
	tile: {
		gridTemplateColumns: 'repeat(2, minmax(0, 15rem))',
		gap: 'clamp(1rem, 2.5vw, 1.5rem)',
		border: 0,
		borderRadius: 0,
		overflow: 'visible',
		'@media (max-width: 640px)': {
			gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
		},
	},
}

const downloadsCss: CSSObject = {
	position: 'absolute',
	right: '0.9rem',
	bottom: '0.85rem',
	display: 'flex',
	gap: '0.4rem',
	/* Hidden until the preview is hovered or a link inside it has focus.
	   Touch screens can't hover, so they always show. */
	opacity: 0,
	transform: 'translateY(4px)',
	transition: `opacity 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
	'@media (hover: none)': { opacity: 1, transform: 'none' },
	'@media (prefers-reduced-motion: reduce)': { transform: 'none' },
}

const plateCss: CSSObject = {
	position: 'relative',
	margin: 0,
	display: 'grid',
	placeItems: 'center',
	'&[data-tone="light"]': { background: '#ffffff', color: '#000000' },
	'&[data-tone="dark"]': { background: '#000000', color: '#ffffff' },
	'& > img': { display: 'block', height: 'auto' },
	'& > figcaption': {
		position: 'absolute',
		left: '1.1rem',
		bottom: '1rem',
		fontSize: '0.8rem',
		letterSpacing: '0.01em',
		opacity: 0.6,
	},
	'&:hover > div, &:focus-within > div': { opacity: 1, transform: 'none' },
}

const plateShapeCss: Record<BrandSection['shape'], CSSObject> = {
	logo: {
		minHeight: 'clamp(10rem, 22vw, 15rem)',
		padding: '2.5rem 1.5rem 3.5rem',
		'& > img': { width: 'clamp(10rem, 24vw, 16rem)' },
	},
	mark: {
		minHeight: 'clamp(12rem, 26vw, 18rem)',
		padding: '2.5rem 1.5rem 3.5rem',
		'& > img': { width: 'clamp(7rem, 16vw, 10rem)' },
	},
	tile: {
		aspectRatio: '1',
		borderRadius: radius.card,
		overflow: 'hidden',
		boxShadow: `0 0 0 1.5px ${colors.border}`,
		'& > img': { position: 'absolute', inset: 0, width: '100%' },
	},
}

const downloadCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.3rem',
	padding: '0.4rem 0.65rem',
	borderRadius: radius.full,
	font: '600 0.72rem/1 ui-monospace, "SF Mono", Menlo, monospace',
	letterSpacing: '0.04em',
	textDecoration: 'none',
	transition: `background-color 160ms ${transitions.easeOut}`,
	'[data-tone="light"] &': {
		color: '#000000',
		backgroundColor: 'rgb(0 0 0 / 0.06)',
		boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.14)',
	},
	'[data-tone="dark"] &': {
		color: '#ffffff',
		backgroundColor: 'rgb(255 255 255 / 0.08)',
		boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.2)',
	},
	[hoverMq]: {
		'[data-tone="light"] &:hover': { backgroundColor: 'rgb(0 0 0 / 0.12)' },
		'[data-tone="dark"] &:hover': {
			backgroundColor: 'rgb(255 255 255 / 0.18)',
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
}

const usageListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	gap: '0.9rem clamp(1.5rem, 5vw, 4rem)',
	color: colors.textMuted,
	lineHeight: 1.55,
	'& strong': { color: colors.text, fontWeight: 650 },
	'@media (max-width: 640px)': { gridTemplateColumns: '1fr' },
}
