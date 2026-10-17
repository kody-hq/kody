/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { type CSSObject } from '@emotion/react'

import { useState } from 'react'
import {
	youtubeNocookieEmbedUrl,
	youtubeThumbPath,
} from '#universal/youtube-watch.ts'
import { colors, radius, typography } from '#universal/styles/tokens.ts'

/**
 * First-party lite YouTube player: poster + play, then the privacy-enhanced
 * embed. Used by the site-wide `/?youtubeId=` overlay, the homepage hero,
 * and docs `[!WATCH]` figures.
 * Playback starts on click so `prefers-reduced-motion` never autoplays; the
 * one exception is `autoplay`, which callers set only after the visitor has
 * already picked a video (a click is the gesture). When `videoId` changes the
 * player re-derives its state for the new video instead of carrying the old
 * one over. The same `videoId` still starts when `autoplay` becomes true so
 * the hero chooser can play the already-selected clip.
 */
export function nextLightPlayerPlaying(input: {
	playing: boolean
	renderedVideoId: string
	videoId: string
	autoplay: boolean
}) {
	if (input.videoId !== input.renderedVideoId) {
		return {
			renderedVideoId: input.videoId,
			playing: input.autoplay,
		}
	}
	return {
		renderedVideoId: input.renderedVideoId,
		playing: input.playing || input.autoplay,
	}
}

export function YouTubeLightPlayer(props: {
	videoId: string
	playlistId?: string
	title?: string
	playTestId?: string
	autoplay?: boolean
}) {
	const [state, setState] = useState({
		renderedVideoId: props.videoId,
		playing: props.autoplay === true,
	})
	const next = nextLightPlayerPlaying({
		...state,
		videoId: props.videoId,
		autoplay: props.autoplay === true,
	})
	if (
		next.renderedVideoId !== state.renderedVideoId ||
		next.playing !== state.playing
	)
		setState(next)
	const videoId = props.videoId
	const playing = next.playing
	const title = props.title ?? 'YouTube video'
	const playLabel = props.title ? `Play ${title}` : 'Play video'
	if (playing) {
		return (
			<iframe
				title={title}
				src={youtubeNocookieEmbedUrl(videoId, {
					playlistId: props.playlistId,
				})}
				allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
				allowFullScreen
				css={frameCss}
			/>
		)
	}

	return (
		<button
			type="button"
			data-testid={props.playTestId}
			css={posterButtonCss}
			onClick={() => setState({ renderedVideoId: videoId, playing: true })}
		>
			<img
				src={publicAsset(youtubeThumbPath(videoId))}
				alt=""
				width={1280}
				height={720}
				css={posterImageCss}
			/>
			<span css={playBadgeCss} aria-hidden="true">
				▶
			</span>
			<span css={visuallyHiddenCss}>{playLabel}</span>
		</button>
	)
}

const frameCss = {
	width: '100%',
	height: '100%',
	border: 'none',
} satisfies CSSObject

const posterButtonCss = {
	appearance: 'none',
	display: 'block',
	width: '100%',
	height: '100%',
	padding: 0,
	border: 'none',
	backgroundColor: '#000',
	cursor: 'pointer',
	position: 'relative' as const,
	'&:focus-visible': {
		outline: 'none',
		boxShadow: `inset 0 0 0 3px ${colors.primary}`,
	},
} satisfies CSSObject

const posterImageCss = {
	// Fill the stage. Docs prose also styles `img`; the prose override for
	// `[data-doc-youtube] img` repeats these so a later prose layer cannot
	// push the poster down with margin and leave a black strip.
	display: 'block' as const,
	width: '100%',
	maxWidth: 'none',
	height: '100%',
	margin: 0,
	border: 'none',
	borderRadius: 0,
	objectFit: 'cover' as const,
} satisfies CSSObject

const playBadgeCss = {
	position: 'absolute' as const,
	inset: 0,
	margin: 'auto',
	width: '4.5rem',
	height: '4.5rem',
	borderRadius: radius.full,
	backgroundColor: 'rgba(0, 0, 0, 0.72)',
	color: colors.onScrim,
	display: 'grid',
	placeItems: 'center',
	fontSize: '1.5rem',
	lineHeight: 1,
} satisfies CSSObject

const visuallyHiddenCss = {
	position: 'absolute' as const,
	width: '1px',
	height: '1px',
	padding: 0,
	margin: '-1px',
	overflow: 'hidden' as const,
	clip: 'rect(0, 0, 0, 0)',
	whiteSpace: 'nowrap' as const,
	border: 0,
	fontFamily: typography.fontFamily,
} satisfies CSSObject
