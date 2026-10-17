/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { YouTubeLightPlayer } from './youtube-light-player.tsx'
import {
	landingHeroChooserLabel,
	presentLandingHeroVideos,
	type LandingHeroVideo,
} from '#universal/landing-hero-copy.ts'
import { youtubeThumbPath } from '#universal/youtube-watch.ts'

/**
 * Where a keypress moves the chooser's active thumbnail. `null` means the key
 * is not a navigation key. Arrows wrap at both ends so a long strip can be
 * walked in either direction from wherever the visitor is. Both axes are
 * accepted so up/down feel natural on a touch-scrolled strip too.
 */
export function nextChooserIndex(
	current: number,
	key: string,
	count: number,
): number | null {
	if (count <= 0) return null
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
			return (current + 1) % count
		case 'ArrowLeft':
		case 'ArrowUp':
			return (current - 1 + count) % count
		case 'Home':
			return 0
		case 'End':
			return count - 1
		default:
			return null
	}
}

/**
 * Which edges of a horizontal scroller have more content past them. Drives
 * the fade masks so an edge only fades when there is something to scroll to.
 */
export function chooserOverflow(input: {
	scrollLeft: number
	clientWidth: number
	scrollWidth: number
}) {
	return {
		start: input.scrollLeft > 1,
		end: input.scrollLeft + input.clientWidth < input.scrollWidth - 1,
	}
}

function prefersReducedMotion() {
	return (
		typeof window !== 'undefined' &&
		window.matchMedia('(prefers-reduced-motion: reduce)').matches
	)
}

/**
 * Hero media column: the lite player plus a single-tab-stop listbox of
 * thumbnails under it, laid out as a horizontally scrolling strip so the list
 * can grow. Clicking a thumbnail (or Enter/Space on the active one) swaps the
 * video in the player and starts it, since choosing a video is the play
 * gesture. Arrow keys move the active thumbnail (wrapping) and scroll it into
 * view without changing the video; hover and keyboard-active both zoom the
 * whole thumbnail (neighbours step aside) and slide its title out from behind
 * it (see `.landing-hero-chooser*` in styles.css). Choosing moves focus to the
 * player.
 */
export function LandingHeroVideo({
	videos: suppliedVideos,
}: {
	videos: ReadonlyArray<LandingHeroVideo>
}) {
	const videos = presentLandingHeroVideos(suppliedVideos)
	const [selection, setSelection] = useState({ index: 0, chosen: false })
	const [active, setActiveIndex] = useState(0)
	const [overflow, setOverflow] = useState({ start: false, end: false })
	const scroller = useRef<HTMLDivElement>(null)
	const id = useId()
	const playerId = id + '-player'
	const optionId = (index: number) => id + '-video-' + index
	const selectedIndex = selection.index < videos.length ? selection.index : 0
	const activeIndex = active < videos.length ? active : 0
	const chosen = selection.chosen
	const overflowStart = overflow.start,
		overflowEnd = overflow.end
	useEffect(() => {
		const node = scroller.current
		if (!node) return
		function sync() {
			if (node) setOverflow(chooserOverflow(node))
		}
		const observer = new ResizeObserver(sync)
		observer.observe(node)
		node.addEventListener('scroll', sync, { passive: true })
		sync()
		return () => {
			observer.disconnect()
			node.removeEventListener('scroll', sync)
		}
	}, [videos.length])
	useEffect(() => {
		const node = scroller.current,
			option = document.getElementById(id + '-video-' + activeIndex)
		if (node && option)
			node.scrollTo({
				left: option.offsetLeft - (node.clientWidth - option.offsetWidth) / 2,
				behavior: prefersReducedMotion() ? 'auto' : 'smooth',
			})
	}, [activeIndex, id])
	useEffect(() => {
		if (chosen)
			document
				.getElementById(playerId)
				?.querySelector<HTMLIFrameElement>('iframe')
				?.focus({ preventScroll: true })
	}, [selectedIndex, chosen, playerId])
	function choose(index: number) {
		if (index < 0 || index >= videos.length) return
		setSelection({ index, chosen: true })
		setActiveIndex(index)
	}
	const selected = videos[selectedIndex]
	if (!selected) return null

	return (
		<div className="landing-hero-media">
			<div
				id={playerId}
				data-rise
				style={{ '--rise': '1' } as CSSProperties}
				className="landing-hero-video"
			>
				<YouTubeLightPlayer
					videoId={selected.videoId}
					title={selected.title}
					autoplay={chosen}
					playTestId="landing-hero-video-play"
				/>
			</div>
			{videos.length > 1 ? (
				<div
					role="listbox"
					tabIndex={0}
					aria-label={landingHeroChooserLabel}
					aria-activedescendant={optionId(activeIndex)}
					data-rise
					style={{ '--rise': '1.5' } as CSSProperties}
					className="landing-hero-chooser"
					data-testid="landing-hero-chooser"
					data-overflow-start={overflowStart ? '' : undefined}
					data-overflow-end={overflowEnd ? '' : undefined}
					ref={scroller}
					onKeyDown={(event) => {
						const next = nextChooserIndex(activeIndex, event.key, videos.length)
						if (next !== null) {
							event.preventDefault()
							setActiveIndex(next)
							return
						}
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							choose(activeIndex)
						}
					}}
				>
					{videos.map((video, index) => (
						<div
							key={video.videoId}
							id={optionId(index)}
							role="option"
							tabIndex={-1}
							aria-selected={index === selectedIndex ? 'true' : 'false'}
							data-active={index === activeIndex ? '' : undefined}
							className="landing-hero-chooser-option"
							onClick={() => choose(index)}
						>
							<span className="landing-hero-chooser-thumb">
								<img
									src={publicAsset(youtubeThumbPath(video.videoId))}
									alt=""
									width={480}
									height={270}
									loading="lazy"
									decoding="async"
								/>
							</span>
							<span className="landing-hero-chooser-title">{video.title}</span>
						</div>
					))}
				</div>
			) : null}
		</div>
	)
}
