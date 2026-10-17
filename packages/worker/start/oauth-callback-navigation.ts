import { type ParsedHistoryState } from '@tanstack/history'

declare module '@tanstack/history' {
	interface HistoryState {
		oauthCallbackFlow?: { key: string; href: string }
	}
}

/** Only the sanitized entry retains this flow, never another destination. */
export function oauthCallbackFlowKey(location: {
	href: string
	state: ParsedHistoryState
}) {
	const flow = location.state.oauthCallbackFlow
	return flow?.href === location.href
		? flow.key
		: (location.state.__TSR_key ?? location.state.key)
}

/** Refreshing the same history entry is safe; departing it ends the flow. */
export function createOAuthCallbackNavigationScope(initialLocation: {
	href: string
	state: ParsedHistoryState
}) {
	let entry = initialLocation
	const entryKey = (location: typeof initialLocation) =>
		location.state.__TSR_key ?? location.state.key
	let active = true
	let replacement: { href: string; key: string } | null = null
	return {
		isActive: () => active,
		replace(href: string, key: string) {
			replacement = { href, key }
		},
		navigate(location: { href: string; state: ParsedHistoryState }) {
			if (
				replacement &&
				location.href === replacement.href &&
				location.state.oauthCallbackFlow?.key === replacement.key
			) {
				entry = location
				replacement = null
				return
			}
			// Router invalidation reloads the current entry and emits this event too.
			// Compare the actual history key, not the retained callback component key,
			// so a new visit to the same URL cannot revive a departed flow.
			if (
				location.href === entry.href &&
				entryKey(location) === entryKey(entry)
			)
				return
			active = false
		},
	}
}
