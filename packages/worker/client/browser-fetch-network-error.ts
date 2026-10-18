/**
 * Browser `fetch()` network failures that reject as TypeError. Exact strings
 * only — Firefox (KODY-CLOUDFLARE-3P), Chromium, and WebKit — so unrelated
 * TypeErrors still surface their own message.
 *
 * Chromium Mobile sometimes appends the failed origin as a parenthetical
 * (`Failed to fetch (kody.codes)`, KODY-6A) — that is still the same network
 * blip, not "Failed to fetch dynamically imported module: …".
 */

const browserFetchNetworkErrorMessages = new Set([
	'NetworkError when attempting to fetch resource.',
	'Failed to fetch',
	'Load failed',
])

/** Chromium "Failed to fetch (hostname)" without matching dynamic-import text. */
const chromiumFailedToFetchWithOrigin = /^Failed to fetch(?:\s+\([^)]+\))?$/i

function normalizeBrowserFetchNetworkErrorMessage(message: string) {
	const withoutTypePrefix = message.trim().replace(/^TypeError:\s*/i, '')
	if (chromiumFailedToFetchWithOrigin.test(withoutTypePrefix)) {
		return 'Failed to fetch'
	}
	return withoutTypePrefix
}

export function isBrowserFetchNetworkErrorMessage(message: string) {
	return browserFetchNetworkErrorMessages.has(
		normalizeBrowserFetchNetworkErrorMessage(message),
	)
}

export function isBrowserFetchNetworkError(error: unknown): boolean {
	if (!(error instanceof TypeError)) return false
	return isBrowserFetchNetworkErrorMessage(error.message)
}
