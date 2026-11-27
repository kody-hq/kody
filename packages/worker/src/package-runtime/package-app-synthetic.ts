export const packageAppSyntheticHeaderName = 'Kody-Synthetic'
export const packageAppSyntheticHeaderValue = 'true'

export const appFetchCapabilityName = 'appFetch'

/**
 * Platform-only options for trusted in-process app dispatch.
 * `agent` requests an actionable response for missing visitor-need consent.
 * `synthetic` opts in to the `Kody-Synthetic` header. Run-as-me refusals use a
 * 403 for either kind of dispatch; inbound headers set neither option.
 */
export type PackageAppTrustedDispatch = {
	readonly agent?: true
	readonly synthetic?: boolean
}

/** Marks a visitor-need consent refusal; the response body names the need. */
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
