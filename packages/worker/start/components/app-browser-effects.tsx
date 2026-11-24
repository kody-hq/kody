/** @jsxImportSource @emotion/react */
import { useRef, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { visuallyHiddenCss } from '#universal/styles/style-primitives.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'
import { useResourceLifetime } from '../lib/primitives.ts'

export function AppBrowserEffects() {
	return (
		<>
			<NavigationProgress />
			<PendingPageFade />
		</>
	)
}

/**
 * Dims the page on screen once a navigation has been pending for a while, so
 * the wait is visible without the page being taken away. Held for a minimum
 * time once shown, so it never flickers.
 */
function PendingPageFade() {
	const pending = useRouterState({ select: (state) => state.isLoading })
	const faded = useSpinDelay(pending, { delay: 500, minDuration: 300 })
	useResourceLifetime(() => {
		if (!faded) return () => {}
		document.documentElement.setAttribute('data-route-pending', '')
		return () => document.documentElement.removeAttribute('data-route-pending')
	}, [faded])
	// The dimming is visual only; this announces the same wait.
	return (
		<span role="status" css={visuallyHiddenCss} data-route-pending-status>
			{faded ? 'Loading' : ''}
		</span>
	)
}

/**
 * True once `loading` has lasted `delay`, and then for at least `minDuration`.
 * Same contract as npm's spin-delay, which ships only a UMD build that the
 * Workers server render cannot load.
 */
function useSpinDelay(
	loading: boolean,
	{ delay, minDuration }: { delay: number; minDuration: number },
) {
	const [shown, setShown] = useState(false)
	const shownAt = useRef(0)
	useResourceLifetime(() => {
		if (loading === shown) return () => {}
		const timeout = setTimeout(
			() => {
				if (loading) shownAt.current = Date.now()
				setShown(loading)
			},
			loading
				? delay
				: Math.max(0, minDuration - (Date.now() - shownAt.current)),
		)
		return () => clearTimeout(timeout)
	}, [loading, shown, delay, minDuration])
	return shown
}

function NavigationProgress() {
	const pending = useRouterState({ select: (state) => state.isLoading })
	const [bar, setBar] = useState({ visible: false, progress: 0, opacity: 0 })
	const visible = useRef(false)
	const shownAt = useRef(0)
	useResourceLifetime(() => {
		const timeouts: Array<ReturnType<typeof setTimeout>> = []
		let interval: ReturnType<typeof setInterval> | undefined
		function after(delay: number, callback: () => void) {
			timeouts.push(setTimeout(callback, delay))
		}
		function show() {
			if (!visible.current) shownAt.current = Date.now()
			visible.current = true
			setBar((current) => ({
				visible: true,
				progress:
					current.progress >= 100 || current.progress === 0
						? 8
						: current.progress,
				opacity: 1,
			}))
			interval = setInterval(
				() =>
					setBar((current) => ({
						...current,
						progress: Math.min(90, current.progress + 4),
					})),
				200,
			)
		}
		if (pending) {
			if (visible.current) show()
			else after(150, show)
		} else if (visible.current) {
			after(Math.max(0, 200 - (Date.now() - shownAt.current)), () => {
				setBar({ visible: true, progress: 100, opacity: 1 })
				after(80, () => {
					setBar((current) => ({ ...current, opacity: 0 }))
					after(200, () => {
						visible.current = false
						setBar({ visible: false, progress: 0, opacity: 0 })
					})
				})
			})
		}
		return () => {
			timeouts.forEach(clearTimeout)
			if (interval) clearInterval(interval)
		}
	}, [pending])
	if (!bar.visible) return null
	return (
		<div
			aria-hidden="true"
			data-navigation-progress
			css={{
				position: 'fixed',
				top: 0,
				left: 0,
				width: '100%',
				height: '3px',
				zIndex: 9999,
				pointerEvents: 'none',
				backgroundColor: 'transparent',
			}}
		>
			<div
				css={{
					height: '100%',
					width: '100%',
					transform: `scaleX(${bar.progress / 100})`,
					transformOrigin: 'left',
					backgroundColor: colors.primary,
					opacity: bar.opacity,
					transition: `transform 200ms ${transitions.easeOut}, opacity 200ms ${transitions.easeOut}`,
				}}
			/>
		</div>
	)
}
