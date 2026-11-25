import type { AnyRouter } from '@tanstack/react-router'

/**
 * Tracks the router load in flight, for at most `navigationLoadArmMs`.
 * A navigation (link, redirect, back/forward) changes the href and may load a
 * fresh document. A refresh (`router.invalidate()` after a save or upload)
 * keeps the href and must keep the page, since it can run beside unsaved work.
 * Tab-return activation, polling and background refetches go through Query,
 * not the router, so they are neither.
 */
export const navigationLoadArmMs = 30_000

type RouterLoad = 'navigation' | 'refresh'

let routerLoad: RouterLoad = 'navigation'
let routerLoadUntil = 0

function setRouterLoad(load: RouterLoad | null) {
	routerLoad = load ?? 'navigation'
	routerLoadUntil = load ? Date.now() + navigationLoadArmMs : 0
}

export function setNavigationLoadArmed(armed: boolean) {
	setRouterLoad(armed ? 'navigation' : null)
}

function readRouterLoad(): RouterLoad | null {
	return Date.now() <= routerLoadUntil ? routerLoad : null
}

export function isNavigationLoadArmed() {
	return readRouterLoad() === 'navigation'
}

export function isRouterRefreshLoad() {
	return readRouterLoad() === 'refresh'
}

/** Chunk imports and route RPCs both run before `onResolved`. */
export function armNavigationLoads(router: Pick<AnyRouter, 'subscribe'>) {
	const stopBefore = router.subscribe('onBeforeLoad', (event) => {
		setRouterLoad(event.hrefChanged ? 'navigation' : 'refresh')
	})
	const stopResolved = router.subscribe('onResolved', () => {
		setRouterLoad(null)
	})
	return () => {
		stopBefore()
		stopResolved()
	}
}
