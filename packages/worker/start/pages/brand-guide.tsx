/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type ReactNode } from 'react'
import { publicAsset } from '../public-assets.ts'
import { KodyMark } from '../components/kody-mark.tsx'
import { kodyBrandAssets } from '../brand/kody-mark-path.ts'
import { colors, radius, transitions } from '#universal/styles/tokens.ts'
import {
	hoverMq,
	layoutMaxWidths,
	pageEyebrowCss,
	pageGutter,
	pageHeadCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'

const solidDownloads = [
	{
		href: kodyBrandAssets.pngOutlinedSolidLight,
		filename: 'kody-mark-outlined-solid-light.png',
		label: 'Download PNG: outlined black on white',
		alt: 'Outlined black Kody mark on a white square',
		note: 'For light surfaces, app icons, and marketplace uploads.',
	},
	{
		href: kodyBrandAssets.pngSolidDark,
		filename: 'kody-mark-solid-dark.png',
		label: 'Download PNG: solid white on black',
		alt: 'Solid white Kody mark on a black square',
		note: 'For dark surfaces without a theme.',
	},
]

const logoDownloads = [
	{
		format: 'SVG',
		href: kodyBrandAssets.logoSvgOutlined,
		filename: 'kody-logo-outlined.svg',
		label: 'Download full logo SVG (outlined, for light backgrounds)',
		note: 'Outlined mark with the black wordmark',
		size: 'Vector',
	},
	{
		format: 'SVG',
		href: kodyBrandAssets.logoSvgWhite,
		filename: 'kody-logo-white.svg',
		label: 'Download full logo SVG (solid white, for dark backgrounds)',
		note: 'Solid mark with the white wordmark',
		size: 'Vector',
	},
	{
		format: 'PNG',
		href: kodyBrandAssets.logoPngOutlined,
		filename: 'kody-logo-outlined.png',
		label: 'Download full logo PNG (transparent / outlined)',
		note: 'Transparent. For light backgrounds.',
		size: '2048×563',
	},
	{
		format: 'PNG',
		href: kodyBrandAssets.logoPngWhite,
		filename: 'kody-logo-white.png',
		label: 'Download full logo PNG (transparent / solid white)',
		note: 'Transparent. For dark backgrounds.',
		size: '2048×563',
	},
]

const sourceDownloads = [
	{
		format: 'SVG',
		href: kodyBrandAssets.svgOutlined,
		filename: 'kody-mark-outlined.svg',
		label: 'Download SVG (outlined, for light backgrounds)',
		note: 'Black line-art outline with solid eyes and nose',
		size: 'Vector',
	},
	{
		format: 'SVG',
		href: kodyBrandAssets.svg,
		filename: 'kody-mark.svg',
		label: 'Download SVG (solid black)',
		note: 'Solid evenodd path; same geometry as the dark mark',
		size: 'Vector',
	},
	{
		format: 'SVG',
		href: kodyBrandAssets.svgWhite,
		filename: 'kody-mark-white.svg',
		label: 'Download SVG (solid white, for dark backgrounds)',
		note: 'White solid mark for dark surfaces',
		size: 'Vector',
	},
	{
		format: 'PNG',
		href: kodyBrandAssets.pngOutlined,
		filename: 'kody-mark-outlined.png',
		label: 'Download PNG (transparent / outlined)',
		note: 'Transparent. For light backgrounds.',
		size: '2048×1505',
	},
	{
		format: 'PNG',
		href: kodyBrandAssets.pngBlack,
		filename: 'kody-mark-black.png',
		label: 'Download PNG (transparent / solid black)',
		note: 'Transparent. For light backgrounds.',
		size: '2048×1505',
	},
	{
		format: 'PNG',
		href: kodyBrandAssets.pngWhite,
		filename: 'kody-mark-white.png',
		label: 'Download PNG (transparent / solid white)',
		note: 'Transparent. For dark backgrounds.',
		size: '2048×1505',
	},
]

const usageRules = [
	{
		title: 'Clear space.',
		body: 'Keep empty space around the mark at least a quarter of its height on every side. The solid downloads already include comfortable padding.',
	},
	{
		title: 'Do not distort.',
		body: 'Scale proportionally. Do not stretch, skew, rotate into a lockup, or crop the ears or snout.',
	},
	{
		title: 'Color.',
		body: 'Outlined black on light backgrounds, solid white on dark backgrounds. Do not recolor beyond those two values, add gradients, or place the mark on busy photos without a solid scrim.',
	},
	{
		title: 'Wordmark.',
		body: 'Use the full logo files instead of setting “Kody” next to the mark yourself. The wordmark is outlined, so it renders the same without the font installed.',
	},
]

/**
 * Public brand guide: mark treatments, downloads, and simple usage rules.
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
					The Kody mark is a koala head. On light surfaces use the outlined
					line-art mark (black). On dark surfaces use the solid mark (white). Do
					not recolor beyond those two treatments.
				</p>
			</header>

			<section aria-labelledby="mark-preview-heading" css={heroCss}>
				<h2 id="mark-preview-heading" css={visuallyHiddenCss}>
					Theme-aware mark
				</h2>
				<div css={splitCss}>
					<figure css={[splitHalfCss, splitLightCss]}>
						<KodyMark size={168} variant="outlined" title="Kody" />
						<figcaption>
							Light: outlined mark (for light backgrounds)
						</figcaption>
					</figure>
					<figure css={[splitHalfCss, splitDarkCss]}>
						<KodyMark size={168} variant="solid" title="Kody" />
						<figcaption>Dark: solid mark (for dark backgrounds)</figcaption>
					</figure>
				</div>
				<p css={heroNoteCss}>
					Inline UI follows the page theme. Prefer the transparent downloads
					when you control the background.
				</p>
			</section>

			<section aria-labelledby="logo-heading" css={sectionCss}>
				<SectionIntro number="01" id="logo-heading" title="Full logo">
					The mark and the “Kody” wordmark in Bricolage Grotesque, spaced
					exactly like the site header. Outlined on light, solid white on dark.
				</SectionIntro>
				<div css={splitCss}>
					<figure css={[splitHalfCss, logoHalfCss, splitLightCss]}>
						<img
							src={publicAsset(kodyBrandAssets.logoSvgOutlined)}
							alt="Kody logo: outlined mark and black wordmark"
							width={364}
							height={100}
							css={logoImgCss}
						/>
						<figcaption>Light: outlined logo</figcaption>
					</figure>
					<figure css={[splitHalfCss, logoHalfCss, splitDarkCss]}>
						<img
							src={publicAsset(kodyBrandAssets.logoSvgWhite)}
							alt="Kody logo: solid white mark and wordmark"
							width={364}
							height={100}
							css={logoImgCss}
						/>
						<figcaption>Dark: solid white logo</figcaption>
					</figure>
				</div>
				<DownloadList downloads={logoDownloads} />
			</section>

			<section aria-labelledby="solid-downloads-heading" css={sectionCss}>
				<SectionIntro
					number="02"
					id="solid-downloads-heading"
					title="Solid backgrounds"
				>
					Fully opaque 4096×4096 squares for places where light and dark mode
					cannot be controlled: plugin directories, OAuth consent screens,
					slides, docs, chat avatars, and social posts.
				</SectionIntro>
				<div css={solidGridCss}>
					{solidDownloads.map((download) => (
						<figure key={download.href} css={solidCardCss}>
							<img
								src={publicAsset(download.href)}
								alt={download.alt}
								width={512}
								height={512}
								loading="lazy"
								css={solidImgCss}
							/>
							<figcaption css={solidCaptionCss}>
								<a
									href={publicAsset(download.href)}
									download={download.filename}
									css={stretchedLinkCss}
								>
									{download.label}
								</a>
								<span>{download.note}</span>
								<span css={metaCss}>PNG · 4096×4096 · Opaque</span>
							</figcaption>
							<DownloadIcon />
						</figure>
					))}
				</div>
			</section>

			<section aria-labelledby="downloads-heading" css={sectionCss}>
				<SectionIntro
					number="03"
					id="downloads-heading"
					title="SVG and transparent PNG"
				>
					SVG is the source of truth. Transparent PNGs are 2048px wide for
					compositing onto your own backgrounds.
				</SectionIntro>
				<DownloadList downloads={sourceDownloads} />
			</section>

			<section aria-labelledby="usage-heading" css={sectionCss}>
				<SectionIntro number="04" id="usage-heading" title="Usage">
					A few rules keep the mark recognizable everywhere it shows up.
				</SectionIntro>
				<ol css={usageListCss}>
					{usageRules.map((rule) => (
						<li key={rule.title}>
							<strong>{rule.title}</strong>
							<p>{rule.body}</p>
						</li>
					))}
				</ol>
			</section>
		</article>
	)
}

function SectionIntro({
	number,
	id,
	title,
	children,
}: {
	number: string
	id: string
	title: string
	children: ReactNode
}) {
	return (
		<header css={sectionIntroCss}>
			<span css={sectionNumberCss} aria-hidden="true">
				{number}
			</span>
			<h2 id={id}>{title}</h2>
			<p>{children}</p>
		</header>
	)
}

type BrandDownload = {
	format: string
	href: string
	filename: string
	label: string
	note: string
	size: string
}

function DownloadList({ downloads }: { downloads: Array<BrandDownload> }) {
	return (
		<ul css={sourceListCss}>
			{downloads.map((download) => (
				<li key={download.href} css={sourceRowCss}>
					<span css={formatBadgeCss}>{download.format}</span>
					<span css={sourceTextCss}>
						<a
							href={publicAsset(download.href)}
							download={download.filename}
							css={stretchedLinkCss}
						>
							{download.label}
						</a>
						<span>{download.note}</span>
					</span>
					<span css={[metaCss, sourceSizeCss]}>{download.size}</span>
					<DownloadIcon />
				</li>
			))}
		</ul>
	)
}

function DownloadIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			width="20"
			height="20"
			fill="none"
			aria-hidden="true"
			focusable={false}
			data-download-icon
		>
			<path
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.5"
				d="M12 4.75v10.5m0 0 4.25-4.25M12 15.25 7.75 11M5.75 19.25h12.5"
			/>
		</svg>
	)
}

/* The route owns its gutters: the app shell leaves `gutters: 'page'` routes
   unpadded. */
const pageCss: CSSObject = {
	maxWidth: layoutMaxWidths.extended,
	marginInline: 'auto',
	padding: `clamp(3rem, 7vw, 5.5rem) ${pageGutter} clamp(4rem, 8vw, 6.5rem)`,
	display: 'grid',
	gap: 'clamp(3.5rem, 8vw, 6rem)',
}

const headCss: CSSObject = {
	...pageHeadCss,
	'& > p': {
		...pageHeadCss['& > p'],
		maxWidth: '52ch',
	},
}

const eyebrowCss: CSSObject = {
	...pageEyebrowCss,
	marginBottom: '1rem',
}

const heroCss: CSSObject = {
	position: 'relative',
	display: 'grid',
	gap: '1rem',
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

const splitHalfCss: CSSObject = {
	position: 'relative',
	margin: 0,
	display: 'grid',
	placeItems: 'center',
	minHeight: 'clamp(16rem, 34vw, 24rem)',
	padding: '3rem 1.5rem 4rem',
	'& svg': {
		width: 'clamp(9rem, 22vw, 13rem)',
		height: 'auto',
	},
	'& figcaption': {
		position: 'absolute',
		insetInline: '1.25rem',
		bottom: '1.1rem',
		fontSize: '0.8rem',
		letterSpacing: '0.01em',
		opacity: 0.62,
	},
}

const splitLightCss: CSSObject = {
	background: '#ffffff',
	color: '#000000',
}

const splitDarkCss: CSSObject = {
	background: '#000000',
	color: '#ffffff',
}

const logoHalfCss: CSSObject = {
	minHeight: 'clamp(11rem, 22vw, 15rem)',
	padding: '2.5rem 1.5rem 3.5rem',
}

const logoImgCss: CSSObject = {
	display: 'block',
	width: 'clamp(11rem, 26vw, 17rem)',
	height: 'auto',
}

const heroNoteCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: '0.92rem',
	textAlign: 'center',
	textWrap: 'balance',
}

const sectionCss: CSSObject = {
	display: 'grid',
	gap: 'clamp(1.75rem, 4vw, 2.5rem)',
	paddingTop: 'clamp(2rem, 5vw, 3rem)',
	borderTop: `1px solid ${colors.border}`,
}

const sectionIntroCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)',
	columnGap: 'clamp(1.5rem, 5vw, 4rem)',
	rowGap: '0.5rem',
	alignItems: 'baseline',
	'& h2': {
		gridColumn: 1,
		margin: 0,
		fontSize: 'clamp(1.6rem, 3vw, 2.1rem)',
		fontWeight: 720,
		letterSpacing: '-0.022em',
		lineHeight: 1.1,
		textWrap: 'balance',
	},
	'& p': {
		gridColumn: 2,
		gridRow: '1 / span 2',
		alignSelf: 'end',
		margin: 0,
		color: colors.textMuted,
		lineHeight: 1.6,
		maxWidth: '58ch',
		textWrap: 'pretty',
	},
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
		'& p': {
			gridColumn: 1,
			gridRow: 'auto',
			marginTop: '0.25rem',
		},
	},
}

const sectionNumberCss: CSSObject = {
	gridColumn: 1,
	font: '600 0.78rem/1 ui-monospace, "SF Mono", Menlo, monospace',
	letterSpacing: '0.08em',
	color: colors.primaryText,
}

const metaCss: CSSObject = {
	font: '500 0.74rem/1.3 ui-monospace, "SF Mono", Menlo, monospace',
	letterSpacing: '0.02em',
	color: colors.textMuted,
}

/* Pairs with a `position: relative` parent so the whole card or row is the
   download target while the visible label stays the accessible name. */
const stretchedLinkCss: CSSObject = {
	color: colors.text,
	fontWeight: 600,
	textDecoration: 'none',
	'&::after': {
		content: '""',
		position: 'absolute',
		inset: 0,
		borderRadius: 'inherit',
	},
	'&:focus-visible': { outline: 'none' },
	'&:focus-visible::after': {
		/* Inset so the download list's `overflow: hidden` cannot clip it. */
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '-2px',
	},
}

const interactiveSurfaceCss: CSSObject = {
	position: 'relative',
	transition: `border-color 160ms ${transitions.easeOut}, background-color 160ms ${transitions.easeOut}`,
	'& [data-download-icon]': {
		color: colors.textMuted,
		transition: `color 160ms ${transitions.easeOut}, transform 160ms ${transitions.easeOut}`,
	},
	[hoverMq]: {
		'&:hover': { borderColor: colors.primary },
		'&:hover a': { color: colors.primaryText },
		'&:hover [data-download-icon]': {
			color: colors.primaryText,
			transform: 'translateY(2px)',
		},
	},
	'@media (prefers-reduced-motion: reduce)': {
		'&:hover [data-download-icon]': { transform: 'none' },
	},
}

const solidGridCss: CSSObject = {
	display: 'grid',
	gap: 'clamp(1rem, 2.5vw, 1.5rem)',
	gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
}

const solidCardCss: CSSObject = {
	...interactiveSurfaceCss,
	margin: 0,
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	gap: '1rem 0.75rem',
	alignContent: 'start',
	padding: '0.75rem 0.75rem 1.1rem',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	'& [data-download-icon]': {
		...(interactiveSurfaceCss['& [data-download-icon]'] as CSSObject),
		alignSelf: 'start',
		marginTop: '0.1rem',
		marginRight: '0.35rem',
	},
}

const solidImgCss: CSSObject = {
	gridColumn: '1 / -1',
	display: 'block',
	width: '100%',
	height: 'auto',
	aspectRatio: '1',
	borderRadius: `calc(${radius.card} - 0.5rem)`,
	boxShadow: `0 0 0 1px ${colors.border}`,
}

const solidCaptionCss: CSSObject = {
	display: 'grid',
	gap: '0.3rem',
	paddingInlineStart: '0.35rem',
	color: colors.textMuted,
	fontSize: '0.9rem',
	lineHeight: 1.45,
	'& > a': { fontSize: '0.98rem' },
	'& > span:last-of-type': { marginTop: '0.35rem' },
}

const sourceListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	backgroundColor: colors.surface,
	border: `1.5px solid ${colors.border}`,
	borderRadius: radius.card,
	overflow: 'hidden',
}

const sourceRowCss: CSSObject = {
	...interactiveSurfaceCss,
	display: 'grid',
	gridTemplateColumns: '3.25rem minmax(0, 1fr) auto auto',
	alignItems: 'center',
	gap: '1rem',
	padding: '1rem 1.25rem',
	'& + &': { borderTop: `1px solid ${colors.border}` },
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest },
		'&:hover a': { color: colors.primaryText },
		'&:hover [data-download-icon]': {
			color: colors.primaryText,
			transform: 'translateY(2px)',
		},
	},
	'@media (max-width: 640px)': {
		gridTemplateColumns: '3rem minmax(0, 1fr) auto',
		padding: '0.9rem 1rem',
	},
}

const formatBadgeCss: CSSObject = {
	justifySelf: 'start',
	padding: '0.3rem 0.5rem',
	borderRadius: radius.sm,
	border: `1px solid ${colors.border}`,
	font: '600 0.7rem/1 ui-monospace, "SF Mono", Menlo, monospace',
	letterSpacing: '0.06em',
	color: colors.textMuted,
}

const sourceTextCss: CSSObject = {
	display: 'grid',
	gap: '0.2rem',
	minWidth: 0,
	'& > span': {
		color: colors.textMuted,
		fontSize: '0.88rem',
	},
}

const sourceSizeCss: CSSObject = {
	whiteSpace: 'nowrap',
	'@media (max-width: 640px)': { display: 'none' },
}

const usageListCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
	gap: 'clamp(1.75rem, 4vw, 2.5rem) clamp(1.5rem, 5vw, 4rem)',
	'@media (max-width: 720px)': {
		gridTemplateColumns: '1fr',
	},
	counterReset: 'usage',
	'& > li': {
		counterIncrement: 'usage',
		display: 'grid',
		alignContent: 'start',
		gridTemplateColumns: '2rem minmax(0, 1fr)',
		columnGap: '0.75rem',
		rowGap: '0.4rem',
	},
	'& > li::before': {
		content: 'counter(usage)',
		gridRow: '1 / span 2',
		display: 'grid',
		placeItems: 'center',
		width: '2rem',
		height: '2rem',
		borderRadius: radius.full,
		backgroundColor: colors.primarySoft,
		color: colors.primaryText,
		font: '600 0.82rem/1 ui-monospace, "SF Mono", Menlo, monospace',
	},
	'& strong': {
		alignSelf: 'center',
		fontSize: '1.05rem',
		fontWeight: 650,
		color: colors.text,
	},
	'& p': {
		gridColumn: 2,
		margin: 0,
		color: colors.textMuted,
		lineHeight: 1.6,
		textWrap: 'pretty',
	},
}
