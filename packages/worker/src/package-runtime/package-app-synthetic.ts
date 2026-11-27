export const packageAppSyntheticHeaderName = 'Kody-Synthetic'
export const packageAppSyntheticHeaderValue = 'true'

export const appFetchCapabilityName = 'appFetch'

/**
 * Platform-only marker for a trusted in-process app visit from `appFetch`.
 * The caller is an agent or script, never a browser, so a missing consent is
 * reported with the link the person opens instead of redirecting to it.
 * `synthetic` is the caller's explicit smoke-test opt-in: it is the only way
 * `Kody-Synthetic` reaches the app. Neither can be set through request
 * headers.
 */
export type PackageAppTrustedDispatch = {
	readonly agent?: true
	readonly synthetic?: boolean
}

/** Set on the 403 that tells an agent which visitor-need consent is missing. */
export const packageAppVisitorConsentRequiredHeader = 'X-Kody-Visitor-Consent'

export function isPackageAppSyntheticRequest(request: Request) {
	return (
		request.headers.get(packageAppSyntheticHeaderName) ===
		packageAppSyntheticHeaderValue
	)
}

export function buildPackageAppNotFoundMessage() {
	return `Saved package app not found. Declare package.json#kody.app and publish, then call the fetch handler with ${appFetchCapabilityName}.`
}

export function buildUnmatchedPackageAppOriginPathMessage() {
	return `Package app URL not found. Hosted package apps are served from https://<username>.<package-app-domain>/<kody-id>/<path> (legacy /packages/<kody-id> paths on that host and /@username/packages/<kody-id> URLs on the bare package-app domain redirect there). Requests outside a package app mount are not dispatched to any app. To call a declared package app fetch handler over MCP, use ${appFetchCapabilityName} instead.`
}
