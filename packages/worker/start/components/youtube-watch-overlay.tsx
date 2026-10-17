/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useEffect, useId, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { type YoutubeWatchLoaderData } from '#universal/loader-data.ts'
import {
	parseYoutubeWatchSearch,
	stripYoutubeWatchSearch,
} from '#universal/youtube-watch.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { YouTubeLightPlayer } from './youtube-light-player.tsx'

export function YouTubeWatchOverlay({
	snapshot,
	location,
}: {
	snapshot?: YoutubeWatchLoaderData
	location: { pathname: string; searchStr: string }
}) {
	const navigate = useNavigate()
	const dialog = useRef<HTMLDialogElement>(null)
	const titleId = useId()
	const videoId = parseYoutubeWatchSearch(location.searchStr)
	const allowed =
		videoId !== null && (snapshot?.allowedVideoIds.includes(videoId) ?? false)
	useEffect(() => {
		const node = dialog.current
		if (allowed && node && !node.open) node.showModal()
		return () => node?.close()
	}, [allowed, videoId])
	function closeWatch() {
		dialog.current?.close()
		const next = stripYoutubeWatchSearch(location.pathname, location.searchStr)
		if (next !== `${location.pathname}${location.searchStr}`)
			void navigate({ to: next })
	}
	if (!videoId || !allowed) return null
	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			data-testid="youtube-watch-overlay"
			data-video-id={videoId}
			css={dialogCss}
			onCancel={(event) => {
				event.preventDefault()
				closeWatch()
			}}
			onClick={(event) => {
				if (event.target === event.currentTarget) closeWatch()
			}}
		>
			<div css={stageCss}>
				<h2 id={titleId} css={visuallyHiddenCss}>
					Watch video
				</h2>
				<YouTubeLightPlayer videoId={videoId} playTestId="youtube-watch-play" />
				<button
					type="button"
					aria-label="Close video"
					data-testid="youtube-watch-close"
					css={closeCss}
					onClick={closeWatch}
				>
					×
				</button>
			</div>
		</dialog>
	)
}

const dialogCss = {
	width: 'min(96vw, 64rem)',
	maxWidth: '96vw',
	padding: 0,
	border: 'none',
	backgroundColor: 'transparent',
	'&::backdrop': {
		backgroundColor: 'rgba(0, 0, 0, 0.82)',
	},
} satisfies CSSObject

const stageCss = {
	position: 'relative' as const,
	width: '100%',
	aspectRatio: '16 / 9',
	backgroundColor: '#000',
	borderRadius: radius.card,
	overflow: 'hidden' as const,
} satisfies CSSObject

const closeCss = {
	position: 'absolute' as const,
	top: spacing.sm,
	right: spacing.sm,
	width: '2.25rem',
	height: '2.25rem',
	border: 'none',
	borderRadius: radius.full,
	backgroundColor: 'rgba(0, 0, 0, 0.72)',
	color: colors.onScrim,
	fontSize: '1.5rem',
	lineHeight: 1,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			backgroundColor: 'rgba(0, 0, 0, 0.9)',
		},
	},
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
