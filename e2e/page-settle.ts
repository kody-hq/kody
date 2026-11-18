import type { Page } from '@playwright/test'

/**
 * Wait for entrance animations to settle before sampling colours.
 *
 * The `rise` reveal animates `opacity: 0 -> 1` over 700ms with a staggered
 * delay, so an element is "visible" to Playwright long before it reaches its
 * final colour. axe computes contrast from the composited pixel, so scanning
 * mid-fade reports the blend against the page ground (the hero title read as
 * `#989b9e` rather than its settled `#171b20`) as a contrast failure.
 *
 * Landing `.reveal` items are CSS transitions that only start after hydration
 * adds `.reveal` then `.in`. Under validate load, that can happen after this
 * wait returns (empty `getAnimations()`), so scans also force reduced motion.
 *
 * Buttons keep color/opacity transitions under reduced motion (feedback, not
 * movement). Auth hydrates the submit control and starts those fades after
 * `ready` can already return, so scans also wait for computed colours to
 * stop changing (#4454).
 *
 * Indefinite animations (the spinner) never finish, so they are skipped rather
 * than waited on. Scroll-driven timelines also stay `running` for the life of
 * the page — treat those as settled too.
 */
export async function waitForAnimationsToSettle(page: Page) {
	await page.waitForFunction(() =>
		document.getAnimations().every((animation) => {
			const timing = animation.effect?.getComputedTiming()
			if (timing?.activeDuration === Infinity) return true
			if (animation.timeline && animation.timeline !== document.timeline) {
				return true
			}
			return animation.playState === 'finished'
		}),
	)
}

export async function waitForSettledColours(page: Page) {
	await page.evaluate(async () => {
		const snapshot = () =>
			[...document.querySelectorAll('button, a, h1, [role="button"]')]
				.slice(0, 12)
				.map((element) => {
					const style = getComputedStyle(element)
					return `${style.color}|${style.backgroundColor}|${style.opacity}`
				})
				.join(';')
		let previous = snapshot()
		let stableFrames = 0
		for (let i = 0; i < 60; i++) {
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => resolve())
			})
			const next = snapshot()
			if (next === previous) {
				stableFrames += 1
				if (stableFrames >= 3) return
			} else {
				stableFrames = 0
				previous = next
			}
		}
	})
}
