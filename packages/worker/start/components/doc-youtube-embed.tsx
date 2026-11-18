/** @jsxImportSource @emotion/react */
import type { CSSObject } from '@emotion/react'

import { YouTubeLightPlayer } from './youtube-light-player.tsx'
import { docYoutubeWatchUrl } from '#universal/doc-youtube.ts'
import { colors, radius } from '#universal/styles/tokens.ts'

/**
 * Docs figure for a `[!WATCH]` block: click-to-play lite player (poster
 * first, privacy-enhanced iframe after the click) plus a caption link to
 * the watch page. The iframe title is the real video title. `vertical`
 * renders a centered 9:16 stage for phone-shot video; the 16:9 poster is
 * cover-cropped to its center, where YouTube places a vertical frame.
 */
export function DocYoutubeEmbed({
	videoId,
	title,
	label,
	vertical = false,
}: {
	videoId: string
	title: string
	label: string
	vertical?: boolean
}) {
	return (
		<figure
			data-doc-youtube=""
			data-doc-youtube-vertical={vertical ? '' : undefined}
			css={[figureCss, vertical ? verticalFigureCss : null]}
		>
			<div css={[stageCss, vertical ? verticalStageCss : null]}>
				<YouTubeLightPlayer
					videoId={videoId}
					title={title}
					playTestId="doc-youtube-play"
				/>
			</div>
			<figcaption css={captionCss}>
				<a
					href={docYoutubeWatchUrl(videoId)}
					target="_blank"
					rel="noopener noreferrer"
				>
					{label}
				</a>
			</figcaption>
		</figure>
	)
}

const figureCss = {
	margin: '1.15rem 0 0',
} satisfies CSSObject

const stageCss = {
	position: 'relative' as const,
	width: '100%',
	aspectRatio: '16 / 9',
	backgroundColor: '#000',
	borderRadius: radius.md,
	overflow: 'hidden' as const,
	border: `1px solid ${colors.border}`,
} satisfies CSSObject

const verticalFigureCss = {
	maxWidth: '22rem',
	marginInline: 'auto',
	textAlign: 'center' as const,
} satisfies CSSObject

const verticalStageCss = {
	aspectRatio: '9 / 16',
} satisfies CSSObject

const captionCss = {
	margin: '0.55rem 0 0',
	maxWidth: '62ch',
	color: colors.textMuted,
	fontSize: '0.95rem',
	lineHeight: 1.45,
	'& a': {
		color: colors.primaryText,
	},
} satisfies CSSObject
