/**
 * Public-site Fathom custom events only (not factory/MCP/execute).
 * Fathom is loaded via SSR with data-spa="auto"; these call trackEvent when
 * the global is present. Never send emails, secrets, or package contents.
 */

import {
	accountCreatedQueryParam,
	fathomEventNames,
	type FathomEventName,
} from '#universal/fathom-events.ts'

export { fathomEventNames, type FathomEventName }

type FathomTracker = {
	trackEvent: (name: string) => void
}

function readFathom(): FathomTracker | null {
	if (typeof window === 'undefined') return null
	const candidate = (window as Window & { fathom?: FathomTracker }).fathom
	if (!candidate || typeof candidate.trackEvent !== 'function') return null
	return candidate
}

/**
 * Fire a named Fathom event. Returns true when Fathom accepted the call.
 * No-ops (returns false) when Fathom is not loaded yet.
 */
export function trackFathomEvent(name: FathomEventName | string): boolean {
	try {
		const fathom = readFathom()
		if (!fathom) return false
		fathom.trackEvent(name)
		return true
	} catch {
		// Analytics must never break auth or navigation.
		return false
	}
}

/**
 * If the current URL carries accountCreated=1, fire account_created and
 * strip the query only after Fathom accepts the event. When Fathom is not
 * ready yet, leave the query so a later hydration pass can retry.
 */
const acceptedAccountCreatedDocuments = new WeakSet<Window>()

export function consumeAccountCreatedFathomSignal(
	replaceHref: (href: string) => void,
): boolean {
	if (typeof window === 'undefined') return false
	try {
		const url = new URL(window.location.href)
		if (url.searchParams.get(accountCreatedQueryParam) !== '1') return false
		if (!acceptedAccountCreatedDocuments.has(window)) {
			if (!trackFathomEvent(fathomEventNames.accountCreated)) return false
			// Acceptance outlives effect remounts and failed URL cleanup.
			acceptedAccountCreatedDocuments.add(window)
		}
		url.searchParams.delete(accountCreatedQueryParam)
		const next = `${url.pathname}${url.search}${url.hash}`
		replaceHref(next)
		return true
	} catch {
		return false
	}
}

const accountCreatedRetryIntervalMs = 250
const accountCreatedRetryAttempts = 40

/**
 * Consume `accountCreated=1` immediately, then retry briefly while the
 * deferred Fathom script may still be loading. No-ops when the query is
 * absent. Returns a cancel function for tests / unmount.
 */
export function scheduleConsumeAccountCreatedFathomSignal(options: {
	replaceHref: (href: string) => void
	intervalMs?: number
	maxAttempts?: number
}): () => void {
	if (typeof window === 'undefined') return () => {}
	try {
		const url = new URL(window.location.href)
		if (url.searchParams.get(accountCreatedQueryParam) !== '1') return () => {}
	} catch {
		return () => {}
	}
	const intervalMs = options?.intervalMs ?? accountCreatedRetryIntervalMs
	const maxAttempts = options?.maxAttempts ?? accountCreatedRetryAttempts
	if (consumeAccountCreatedFathomSignal(options.replaceHref)) return () => {}

	let attempts = 0
	const timer = window.setInterval(() => {
		attempts += 1
		if (
			consumeAccountCreatedFathomSignal(options.replaceHref) ||
			attempts >= maxAttempts
		) {
			window.clearInterval(timer)
		}
	}, intervalMs)
	return () => window.clearInterval(timer)
}
