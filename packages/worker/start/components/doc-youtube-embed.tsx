/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'

import { YouTubeLightPlayer } from './youtube-light-player.tsx'
import { docYoutubeWatchUrl } from '#universal/doc-youtube.ts'
import { colors, radius } from '#universal/styles/tokens.ts'

/**
 * Docs figure for a `[!WATCH]` block: click-to-play lite player (poster
 * first, privacy-enhanced iframe after the click) plus a caption link to
 * the watch page. The iframe title is the real video title.
 */
export function DocYoutubeEmbed({
	videoId,
	title,
	label,
}: {
	videoId: string
	title: string
	label: string
}) {
	return (
		<figure data-doc-youtube="" css={figureCss}>
			<div css={stageCss}>
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
