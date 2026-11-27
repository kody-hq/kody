import { useSyncExternalStore } from 'react'
import {
	blackFridayCountdownText,
	blackFridayDismissStorageKey,
	blackFridayEndsAtMs,
	isBlackFridayActive,
} from './offer.ts'

/**
 * One timer for every banner on the page. The snapshot is the countdown
 * text, `null` once the banner must go (dismissed or sale over), or `''` for
 * the server render, whose slot the pre-paint script fills.
 */
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined
let dismissedInMemory = false

function notify() {
	for (const listener of listeners) listener()
}

function readDismissed() {
	if (dismissedInMemory) return true
	try {
		return localStorage.getItem(blackFridayDismissStorageKey) === '1'
	} catch {
		return false
	}
}

function schedule() {
	clearTimeout(timer)
	const remaining = blackFridayEndsAtMs - Date.now()
	if (remaining <= 0 || listeners.size === 0) return
	// The text changes when the remaining time crosses a whole minute.
	timer = setTimeout(
		() => {
			notify()
			schedule()
		},
		(remaining % 60_000) + 25,
	)
}

function refresh() {
	notify()
	schedule()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	if (listeners.size === 1) {
		// Background tabs throttle timers; catch up when the tab returns.
		document.addEventListener('visibilitychange', refresh)
		window.addEventListener('storage', refresh)
	}
	schedule()
	return () => {
		listeners.delete(listener)
		if (listeners.size > 0) return
		clearTimeout(timer)
		document.removeEventListener('visibilitychange', refresh)
		window.removeEventListener('storage', refresh)
	}
}

function snapshot() {
	const now = Date.now()
	if (!isBlackFridayActive(now) || readDismissed()) return null
	return blackFridayCountdownText(blackFridayEndsAtMs - now)
}

function serverSnapshot() {
	return ''
}

export function useBlackFridayCountdown() {
	return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

export function dismissBlackFriday() {
	dismissedInMemory = true
	try {
		localStorage.setItem(blackFridayDismissStorageKey, '1')
	} catch {
		/* Private mode: the dismissal lasts for this page only. */
	}
	notify()
}
