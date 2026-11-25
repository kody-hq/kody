import type { AnyRouter } from '@tanstack/react-router'

/**
 * Armed only while the router loads a new location (a link, a redirect, or
 * back/forward), and for at most `navigationLoadArmMs`. Activation refreshes,
 * `router.invalidate()` and idle imports keep the same href, so they never
 * arm it. Recovery that loads a fresh document runs only while armed: the user
 * is already leaving the current page, so no in-page input is lost.
 */
export const navigationLoadArmMs = 30_000

let navigationLoadArmedUntil = 0

export function setNavigationLoadArmed(armed: boolean) {
	navigationLoadArmedUntil = armed ? Date.now() + navigationLoadArmMs : 0
}

export function isNavigationLoadArmed() {
	return Date.now() <= navigationLoadArmedUntil
}

/** Chunk imports and route RPCs both run before `onResolved`. */
export function armNavigationLoads(router: Pick<AnyRouter, 'subscribe'>) {
	const stopBefore = router.subscribe('onBeforeLoad', ({ hrefChanged }) => {
		setNavigationLoadArmed(hrefChanged)
	})
	const stopResolved = router.subscribe('onResolved', () => {
		setNavigationLoadArmed(false)
	})
	return () => {
		stopBefore()
		stopResolved()
	}
}
