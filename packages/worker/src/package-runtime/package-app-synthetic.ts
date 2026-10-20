export const packageAppSyntheticHeaderName = 'Kody-Synthetic'
export const packageAppSyntheticHeaderValue = 'true'

export const packageAppFetchCapabilityName = 'packageAppFetch'

/**
 * Platform-only dispatch marker for trusted in-process synthetic app fetches.
 * Callers cannot set this via MCP input; only internal dispatch may opt in.
 */
export type PackageAppTrustedDispatch = {
	readonly synthetic: true
}

export function isPackageAppSyntheticRequest(request: Request) {
	return (
		request.headers.get(packageAppSyntheticHeaderName) ===
		packageAppSyntheticHeaderValue
	)
}

export function buildPackageAppNotFoundMessage() {
	return `Saved package app not found. Declare package.json#kody.app and publish, then smoke-test the fetch handler with ${packageAppFetchCapabilityName}.`
}

export function buildUnmatchedPackageAppOriginPathMessage() {
	return `Package app URL not found. Hosted package apps are served from https://<username>.<package-app-domain>/<kody-id>/<path> (legacy /packages/<kody-id> paths on that host and /@username/packages/<kody-id> URLs on the bare package-app domain redirect there). Requests outside a package app mount are not dispatched to any app. To exercise a declared package app fetch handler over MCP, use ${packageAppFetchCapabilityName} instead.`
}
