/** @jsxImportSource @emotion/react */
import { useEffect, useRef, useState } from 'react'
import { useLocation, useRouter, useRouterState } from '@tanstack/react-router'
import {
	captureFirstTouchAttributionFromLocation,
	clearStoredFirstTouchAttribution,
} from '#client/first-touch-attribution.ts'
import { persistReferralCookieFromLocation } from '#client/referral-cookie.ts'
import { scheduleConsumeAccountCreatedFathomSignal } from '#client/fathom-events.ts'
import { locationWithoutHomeOgParam } from '#universal/home-og-variants.ts'
import { colors, transitions } from '#universal/styles/tokens.ts'

export function AppBrowserEffects() {
	const router = useRouter()
	const href = useLocation({ select: (location) => location.href })
	useEffect(() => {
		captureFirstTouchAttributionFromLocation()
		if (
			new URL(window.location.href).searchParams.get('accountCreated') === '1'
		)
			clearStoredFirstTouchAttribution()
		return scheduleConsumeAccountCreatedFathomSignal({
			replaceHref: (next) =>
				router.history.replace(next, router.history.location.state),
		})
	}, [router])
	useEffect(() => {
		persistReferralCookieFromLocation()
		const next = locationWithoutHomeOgParam(window.location.href)
		if (next) router.history.replace(next, router.history.location.state)
	}, [href, router])
	return <NavigationProgress />
}

function NavigationProgress() {
	const pending = useRouterState({ select: (state) => state.isLoading })
	const [bar, setBar] = useState({ visible: false, progress: 0, opacity: 0 })
	const visible = useRef(false)
	const shownAt = useRef(0)
	useEffect(() => {
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
				viewTransitionName: 'nav-progress',
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
