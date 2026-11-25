import type { AnyRouter } from '@tanstack/react-router'

/**
 * Armed only while the router loads (a link, a redirect, back/forward, or
 * `router.invalidate()` after a save), and for at most `navigationLoadArmMs`.
 * Router loads follow a user action. Tab-return activation refreshes, polling
 * and background query refetches go through Query, not the router, so they
 * never arm it. Recovery that loads a fresh document runs only while armed.
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
	const stopBefore = router.subscribe('onBeforeLoad', () => {
		setNavigationLoadArmed(true)
	})
	const stopResolved = router.subscribe('onResolved', () => {
		setNavigationLoadArmed(false)
	})
	return () => {
		stopBefore()
		stopResolved()
	}
}
