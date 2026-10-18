/**
 * One-shot hard reload when a stale tab's hashed route chunk 404s after a
 * deploy (KODY-5W, KODY-9S, KODY-9V, KODY-9Y). Mirrors
 * `reload-on-unknown-start-release.ts`: set the session flag before reload,
 * clear it after a successful boot so a later deploy can recover again.
 *
 * Match only the three browser dynamic-import failure messages. A blanket
 * TypeError ("Failed to fetch", "Load failed") is a different failure and
 * must not reload.
 */

import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'

export const staleRouteChunkReloadFlag = 'kody:stale-route-chunk-reload'

/**
 * True only between a route load's `onBeforeLoad` and `onResolved`.
 * Idle deferred imports (`sentry-init`, syntax-highlight) must not reload:
 * a successful route boot clears the session flag, so those misses would
 * otherwise reload the tab forever.
 */
let staleRouteChunkReloadArmed = false

export function setStaleRouteChunkReloadArmed(armed: boolean) {
	staleRouteChunkReloadArmed = armed
}

/** Chromium: `Failed to fetch dynamically imported module: <url>`. */
const chromiumDynamicImportFailure =
	/^(?:TypeError:\s*)?Failed to fetch dynamically imported module:\s+\S+$/

/** Firefox: `error loading dynamically imported module: <url>`. */
const firefoxDynamicImportFailure =
	/^(?:TypeError:\s*)?error loading dynamically imported module:\s+\S+$/

/** WebKit: `Importing a module script failed.` (no URL). */
const webkitDynamicImportFailure =
	/^(?:TypeError:\s*)?Importing a module script failed\.$/

function staleRouteChunkLoadMessage(error: unknown) {
	if (typeof error === 'string') return error
	if (typeof error !== 'object' || error === null) return undefined
	if (!('message' in error) || typeof error.message !== 'string')
		return undefined
	return error.message
}

export function isStaleRouteChunkLoadError(error: unknown) {
	const message = staleRouteChunkLoadMessage(error)
	if (message === undefined) return false
	const trimmed = message.trim()
	return (
		chromiumDynamicImportFailure.test(trimmed) ||
		firefoxDynamicImportFailure.test(trimmed) ||
		webkitDynamicImportFailure.test(trimmed)
	)
}

/**
 * If `error` is a post-deploy dynamic-import miss during a route load, attempt
 * one hard reload for this tab session. Returns whether a reload was
 * triggered. No-ops while disarmed so an idle import cannot reload again
 * after boot clears the flag. Never throws when sessionStorage is
 * unavailable (and does not reload in that case, to avoid a loop with no
 * flag). Leave the flag set across a failed recovery; call
 * `clearStaleRouteChunkReloadFlag` after a successful boot.
 *
 * A true result is expected staleness: callers must not report it. A false
 * result because the flag is already set must still be reported.
 */
export function reloadOnStaleRouteChunk(error: unknown): boolean {
	if (!staleRouteChunkReloadArmed) return false
	if (!isStaleRouteChunkLoadError(error)) return false
	if (typeof window === 'undefined') return false
	try {
		if (getSessionStorageItem(staleRouteChunkReloadFlag)) return false
		if (!setSessionStorageItem(staleRouteChunkReloadFlag, '1')) return false
		window.location.reload()
		return true
	} catch {
		return false
	}
}

/** Best-effort clear after a successful client boot (mirrors boot-chunk). */
export function clearStaleRouteChunkReloadFlag(): void {
	try {
		sessionStorage.removeItem(staleRouteChunkReloadFlag)
	} catch {
		// Storage may be unavailable (private mode); clearing is best-effort.
	}
}

/**
 * Vite build preload helper dispatches this when a dependency or the dynamic
 * import itself fails. `preventDefault` only when a reload was triggered, so
 * a second failure (or a non-matching payload such as CSS preload) still
 * surfaces.
 */
export function onVitePreloadError(event: Event) {
	const payload =
		'payload' in event
			? (event as Event & { payload?: unknown }).payload
			: undefined
	if (reloadOnStaleRouteChunk(payload)) event.preventDefault()
}
