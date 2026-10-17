/** @jsxImportSource @emotion/react */
import { useQueryClient } from '@tanstack/react-query'
import {
	useEffect,
	useCallback,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import {
	isElementNearViewport,
	observeNearViewport,
} from '#client/deferred-turnstile.ts'
import { docHref } from '#universal/docs-nav.ts'
import {
	walkthroughHostForAct,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'
import { type TranscriptLine } from '#client/routes/interactive-guide-transcript.ts'
import { renderIcon } from './icon.tsx'
import { fetchLandingLoopHighlights } from '../landing-loop-highlights.ts'
import {
	createLandingLoopPlayer,
	flattenTranscriptActs,
	groupLandingLoopScenes,
	landingLoopChatScrollShouldExplore,
	landingLoopHoldMs,
	landingLoopTeaser,
	landingLoopToggleLabel,
	waitLandingLoopHold,
	type LandingLoopBeat,
	type LandingLoopSceneGroup,
	type LandingLoopToggleLabel,
} from '#client/routes/landing-loop-state.ts'
import { renderWalkthroughKicker } from '../pages/walkthrough-ask-kicker.tsx'
import { SiteLink } from './site-link.tsx'

type LoopLineRenderer = (line: TranscriptLine, actId: string) => ReactNode

export function LandingLoopPlayer({ hosts }: { hosts?: WalkthroughHostPick }) {
	const queryClient = useQueryClient()
	const [content, setContent] = useState<{
		beats: LandingLoopBeat[]
		renderLine: LoopLineRenderer
		reducedMotion: boolean
	} | null>(null)
	const [player, setPlayer] = useState(() =>
		createLandingLoopPlayer({ beatCount: 1, reducedMotion: false }),
	)
	const [loadRequested, setLoadRequested] = useState(false)
	const loop = useRef<HTMLDivElement>(null)
	const chat = useRef<HTMLDivElement>(null)
	const userDriven = useRef(false)
	const autoScrolling = useRef(false)
	const autoScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const pendingSkip = useRef(false)
	const initialPlayer = useRef(player)
	const snapshot = useSyncExternalStore(
		player.subscribe,
		() => `${player.revealedCount}:${player.pauseReasons().join(',')}`,
		() => '1:',
	)
	const reducedMotion = content?.reducedMotion ?? false
	const finePointer = () =>
		window.matchMedia('(hover: hover) and (pointer: fine)').matches
	const scrollTo = useCallback(
		(top?: number) => {
			const node = chat.current
			if (!node) return
			autoScrolling.current = true
			if (autoScrollTimer.current) clearTimeout(autoScrollTimer.current)
			autoScrollTimer.current = setTimeout(() => {
				autoScrolling.current = false
			}, 800)
			node.scrollTo({
				top: top ?? node.scrollHeight,
				behavior: reducedMotion ? 'auto' : 'smooth',
			})
		},
		[reducedMotion],
	)
	useEffect(
		() => () => {
			if (autoScrollTimer.current) clearTimeout(autoScrollTimer.current)
		},
		[],
	)
	useEffect(() => {
		const node = loop.current
		if (!node) return
		return observeNearViewport(node, () => setLoadRequested(true))
	}, [])
	useEffect(() => {
		if (!loadRequested) return
		const controller = new AbortController()
		void Promise.all([
			import('#client/routes/how-kody-works-transcript.ts'),
			import('../pages/interactive-guide-walkthrough.tsx'),
			fetchLandingLoopHighlights(queryClient),
		])
			.then(([transcript, walkthrough, highlights]) => {
				if (controller.signal.aborted) return
				const beats = flattenTranscriptActs(
					transcript.howKodyWorksTranscriptActs,
				)
				const reducedMotion = window.matchMedia(
					'(prefers-reduced-motion: reduce)',
				).matches
				const nextPlayer = createLandingLoopPlayer({
					beatCount: beats.length,
					reducedMotion,
				})
				if (initialPlayer.current.pauseReasons().includes('manual'))
					nextPlayer.pause()
				if (pendingSkip.current && !reducedMotion) nextPlayer.skipToEnd()
				setContent({
					beats,
					reducedMotion,
					renderLine: (line, actId) =>
						walkthrough.renderInteractiveGuideLine(
							line,
							highlights,
							walkthroughHostForAct(hosts, actId),
						),
				})
				setPlayer(nextPlayer)
			})
			.catch(() => {
				if (!controller.signal.aborted) setLoadRequested(false)
			})
		return () => controller.abort()
	}, [loadRequested, hosts, queryClient])
	useEffect(() => {
		const node = loop.current
		if (!node) return
		const sync = () => {
			if (isElementNearViewport(node)) setLoadRequested(true)
			player.setOffscreen(!isElementNearViewport(node, '0px'))
		}
		const observer =
			typeof IntersectionObserver === 'undefined'
				? null
				: new IntersectionObserver(sync)
		observer?.observe(node)
		window.addEventListener('scroll', sync, { passive: true })
		window.addEventListener('resize', sync, { passive: true })
		sync()
		return () => {
			observer?.disconnect()
			window.removeEventListener('scroll', sync)
			window.removeEventListener('resize', sync)
		}
	}, [player])
	useEffect(() => {
		if (!content || reducedMotion) return
		const controller = new AbortController()
		void (async () => {
			while (!controller.signal.aborted) {
				const beat = content.beats[player.revealedCount - 1]
				if (!beat) return
				const finished = await waitLandingLoopHold({
					ms: landingLoopHoldMs(beat),
					isPaused: player.isPaused,
					subscribe: player.subscribe,
					signal: controller.signal,
				})
				if (!finished || controller.signal.aborted) return
				if (!player.isPaused()) player.advance()
			}
		})()
		return () => controller.abort()
	}, [content, player, reducedMotion])
	useEffect(() => {
		if (!content || userDriven.current) return
		const frame = requestAnimationFrame(() => scrollTo())
		return () => cancelAnimationFrame(frame)
	}, [snapshot, content, scrollTo])
	useEffect(() => {
		const node = chat.current
		if (!node) return
		const explore = (event: Event) => {
			if (event.target instanceof HTMLDetailsElement && event.target.open)
				player.setExplore(true)
		}
		const scrollEnd = () => {
			autoScrolling.current = false
		}
		node.addEventListener('toggle', explore, true)
		node.addEventListener('scrollend', scrollEnd)
		return () => {
			node.removeEventListener('toggle', explore, true)
			node.removeEventListener('scrollend', scrollEnd)
		}
	}, [player])
	const visibleBeats = content?.beats.slice(0, player.revealedCount)
	const groups = visibleBeats ? groupLandingLoopScenes(visibleBeats) : []
	const ended = !!content && player.isEnded() && !reducedMotion
	const paused =
		player.pauseReasons().some((reason) => reason !== 'offscreen') &&
		!reducedMotion
	const playing = !!content && !player.isPaused() && !reducedMotion
	const label = landingLoopToggleLabel({ reducedMotion, ended, paused })
	return (
		<div
			ref={loop}
			className="landing-loop"
			data-paused={paused ? 'true' : undefined}
			data-playing={playing ? 'true' : undefined}
			data-ended={ended ? 'true' : undefined}
			aria-label="Factory loop conversation"
			onPointerEnter={() => {
				if (finePointer()) player.setHover(true)
			}}
			onPointerLeave={() => {
				if (finePointer()) player.setHover(false)
			}}
		>
			<div className="landing-loop-head">
				<p className="landing-loop-title">
					<span className="landing-loop-title-full">
						Example conversation with your agents and Kody
					</span>
					<span className="landing-loop-title-short">Example conversation</span>
				</p>
				<span className="landing-loop-toggle-slot">
					{label ? (
						<>
							<button
								type="button"
								className="landing-loop-toggle"
								aria-label={label}
								onClick={() => {
									if (player.isEnded()) {
										userDriven.current = false
										player.restart()
										requestAnimationFrame(() => scrollTo(0))
									} else if (player.isPaused()) {
										userDriven.current = false
										player.play()
										scrollTo()
									} else player.pause()
								}}
							>
								<span className="landing-loop-status-dot" />
								{renderLoopToggleIcon(label)}
							</button>
							<button
								type="button"
								className="landing-loop-toggle"
								aria-label="Skip to the end"
								title="Skip to the end"
								onClick={() => {
									if (reducedMotion || player.isEnded()) return
									userDriven.current = false
									if (!content) {
										pendingSkip.current = true
										setLoadRequested(true)
									} else player.skipToEnd()
								}}
							>
								{renderLoopSkipIcon()}
							</button>
						</>
					) : null}
				</span>
			</div>
			<div
				ref={chat}
				className="landing-loop-chat"
				onPointerDown={() => {
					userDriven.current = true
				}}
				onWheel={() => {
					userDriven.current = true
				}}
				onFocus={() => {
					if (finePointer()) player.setFocus(true)
				}}
				onBlur={(event) => {
					if (
						finePointer() &&
						!(
							event.relatedTarget instanceof Node &&
							event.currentTarget.contains(event.relatedTarget)
						)
					)
						player.setFocus(false)
				}}
				onScroll={() => {
					const node = chat.current
					if (
						node &&
						landingLoopChatScrollShouldExplore({
							autoScrolling: autoScrolling.current,
							userDriven: userDriven.current,
							atBottom:
								node.scrollHeight - node.scrollTop - node.clientHeight <= 28,
						})
					)
						player.setExplore(true)
				}}
			>
				{content && visibleBeats
					? groups.map((group, index) =>
							renderSceneGroup(
								group,
								index,
								content.renderLine,
								index === groups.length - 1,
								hosts,
							),
						)
					: renderTeaser(hosts)}
			</div>
			<p className="landing-loop-foot">
				<SiteLink href={docHref('how-kody-works')}>
					Read the walkthrough
				</SiteLink>
			</p>
		</div>
	)
}

function renderSceneGroup(
	group: LandingLoopSceneGroup,
	groupIndex: number,
	lineRenderer: LoopLineRenderer,
	newestGroup: boolean,
	hosts?: WalkthroughHostPick,
) {
	const lines = group.beats.map((beat, index) =>
		renderBeat(
			beat,
			lineRenderer,
			`${beatKey(beat)}-${index}`,
			newestGroup && index === group.beats.length - 1,
			hosts,
		),
	)
	return (
		<div
			key={`scene-${group.scene}-${groupIndex}`}
			className="landing-loop-scene"
		>
			{groupIndex > 0 ? (
				<p className="landing-loop-later" aria-hidden="true">
					{landingLoopLaterLabel(group)}
				</p>
			) : null}
			{lines}
		</div>
	)
}

function landingLoopLaterLabel(group: LandingLoopSceneGroup) {
	const header = group.beats[0]
	if (header?.kind === 'act' && header.later) return header.later
	return 'Later'
}

function beatKey(beat: LandingLoopBeat) {
	if (beat.kind === 'act') return `act-${beat.id}`
	return `line-${beat.actId}-${beat.line.role}`
}

function renderBeat(
	beat: LandingLoopBeat,
	renderLine: LoopLineRenderer,
	key: string,
	newest: boolean,
	hosts?: WalkthroughHostPick,
) {
	if (beat.kind === 'act') {
		return (
			<header
				key={key}
				className="landing-loop-act"
				data-newest={newest ? 'true' : undefined}
			>
				{beat.kicker ? (
					<p className="landing-loop-kicker">
						{renderWalkthroughKicker(beat.kicker, hosts)}
					</p>
				) : null}
				<h3>{beat.title}</h3>
			</header>
		)
	}
	return (
		<div
			key={key}
			className="landing-loop-line"
			data-newest={newest ? 'true' : undefined}
		>
			{renderLine(beat.line, beat.actId)}
		</div>
	)
}

function renderTeaser(hosts?: WalkthroughHostPick) {
	return (
		<>
			<header className="landing-loop-act">
				{landingLoopTeaser.kicker ? (
					<p className="landing-loop-kicker">
						{renderWalkthroughKicker(landingLoopTeaser.kicker, hosts)}
					</p>
				) : null}
				<h3>{landingLoopTeaser.title}</h3>
			</header>
			<figure className="landing-loop-you">
				<figcaption>You</figcaption>
				<blockquote>
					<p>{landingLoopTeaser.user}</p>
				</blockquote>
			</figure>
		</>
	)
}

function renderLoopToggleIcon(label: LandingLoopToggleLabel) {
	switch (label) {
		case 'Pause':
			return renderIcon('pause', { size: '1em' })
		case 'Play':
			return renderIcon('play', { size: '1em' })
		case 'Restart':
			return renderIcon('redo', { size: '1em' })
		default: {
			const exhaustive: never = label
			return exhaustive
		}
	}
}

function renderLoopSkipIcon() {
	return renderIcon('chevron-down', { size: '1em' })
}
