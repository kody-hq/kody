/**
 * One-shot hard reload when a stale tab's hashed route chunk 404s after a
 * deploy (KODY-5W, KODY-9S, KODY-9V, KODY-9Y, KODY-A1). Mirrors
 * `reload-on-unknown-start-release.ts`: set the session flag before reload,
 * clear it after a successful boot so a later deploy can recover again.
 *
 * Match only the three browser dynamic-import failure messages. A blanket
 * TypeError ("Failed to fetch", "Load failed") is a different failure and
 * must not reload.
 *
 * When `onVitePreloadError` calls `preventDefault` after triggering reload,
 * Vite's `__vitePreload` resolves `undefined` instead of rejecting. TanStack
 * Router then crashes on `module[exportName ?? 'default']` (KODY-A1 /
 * issue 7799039116). Suppress that follow-on only while this page's reload
 * is pending — real undefined-default TypeErrors stay reportable.
 */

import { isSyntaxHighlightCoreDynamicImportFailureError } from '#client/sentry-browser-filters.ts'
import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'

export const staleRouteChunkReloadFlag = 'kody:stale-route-chunk-reload'

/**
 * Longest a single route load may keep the reload armed. `onResolved` only
 * fires for the transaction that wins, so a superseded or abandoned load
 * must not leave the reload armed for later idle imports.
 */
export const staleRouteChunkReloadArmMs = 30_000

/**
 * Armed only between a route load's `onBeforeLoad` and `onResolved`, and for
 * at most `staleRouteChunkReloadArmMs`. Idle deferred imports (`sentry-init`,
 * syntax-highlight) must not reload: a successful route boot clears the
 * session flag, so those misses would otherwise reload the tab forever.
 */
let staleRouteChunkReloadArmedUntil = 0

/**
 * True after this page called `location.reload()` for a stale chunk. Cleared
 * on the next document (reload) or via the test reset helper. Gates follow-on
 * suppression so a spent session flag alone cannot hide real TypeErrors.
 */
let staleRouteChunkReloadTriggered = false

export function setStaleRouteChunkReloadArmed(armed: boolean) {
	staleRouteChunkReloadArmedUntil = armed
		? Date.now() + staleRouteChunkReloadArmMs
		: 0
}

function isStaleRouteChunkReloadArmed() {
	return Date.now() <= staleRouteChunkReloadArmedUntil
}

/** Whether this page already triggered the one-shot stale-chunk reload. */
export function wasStaleRouteChunkReloadTriggered(): boolean {
	return staleRouteChunkReloadTriggered
}

/** Test helper: clear the in-memory reload-triggered bit between cases. */
export function resetStaleRouteChunkReloadTriggered(): void {
	staleRouteChunkReloadTriggered = false
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
 * TanStack `lazyRouteComponent` does `res[exportName ?? 'default']`. After
 * Vite swallows a preload failure via `preventDefault`, `res` is undefined
 * and browsers throw (KODY-A1 / issue 7799039116):
 * - Safari: `undefined is not an object (evaluating 'e[i??`default`]')`
 * - Chromium: `Cannot read properties of undefined (reading 'default')`
 * - Firefox: `can't access property "default" of undefined`
 */
const safariUndefinedModuleDefault =
	/^(?:TypeError:\s*)?undefined is not an object \(evaluating ['"][^'"]*\?\?\s*[`'"]default[`'"][^'"]*['"]\)$/

const chromiumUndefinedModuleDefault =
	/^(?:TypeError:\s*)?Cannot read properties of undefined \(reading ['"]default['"]\)$/

const firefoxUndefinedModuleDefault =
	/^(?:TypeError:\s*)?can't access property ['"]default['"] of undefined$/

export function isStaleRouteChunkUndefinedModuleError(error: unknown) {
	const message = staleRouteChunkLoadMessage(error)
	if (message === undefined) return false
	const trimmed = message.trim()
	return (
		safariUndefinedModuleDefault.test(trimmed) ||
		chromiumUndefinedModuleDefault.test(trimmed) ||
		firefoxUndefinedModuleDefault.test(trimmed)
	)
}

/**
 * Drop the TanStack undefined-module TypeError only when this page already
 * triggered the stale-chunk reload. Without that gate, Chromium's
 * "reading 'default'" wording is too common to filter globally.
 */
export function shouldSuppressStaleRouteChunkFollowOnError(
	error: unknown,
): boolean {
	return (
		staleRouteChunkReloadTriggered &&
		isStaleRouteChunkUndefinedModuleError(error)
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
	if (!isStaleRouteChunkReloadArmed()) return false
	if (!isStaleRouteChunkLoadError(error)) return false
	// Optional Shiki chunk has a plaintext fallback; never reload for it.
	if (isSyntaxHighlightCoreDynamicImportFailureError(error)) return false
	if (typeof window === 'undefined') return false
	try {
		if (getSessionStorageItem(staleRouteChunkReloadFlag)) return false
		if (!setSessionStorageItem(staleRouteChunkReloadFlag, '1')) return false
		window.location.reload()
		// Set after reload returns: if `reload()` throws (e.g. SecurityError),
		// do not leave the follow-on suppress bit set. Session flag is cleared
		// below so a later miss can still attempt recovery.
		staleRouteChunkReloadTriggered = true
		return true
	} catch {
		clearStaleRouteChunkReloadFlag()
		staleRouteChunkReloadTriggered = false
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
 * surfaces. That preventDefault makes the import resolve `undefined`; callers
 * must suppress the resulting TanStack undefined-module TypeError via
 * `shouldSuppressStaleRouteChunkFollowOnError` (KODY-A1).
 */
export function onVitePreloadError(event: Event) {
	const payload =
		'payload' in event
			? (event as Event & { payload?: unknown }).payload
			: undefined
	if (reloadOnStaleRouteChunk(payload)) event.preventDefault()
}
