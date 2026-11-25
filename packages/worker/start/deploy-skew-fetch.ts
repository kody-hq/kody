/**
 * Start `serverFns.fetch` wrapper that keeps a newer deploy's server-fn
 * payloads away from an older client's components (KODY-DP).
 */

import {
	createDeploySkewRecoveryError,
	isDeploySkewReloadPending,
	readClientBuildId,
	reloadOnDeploySkew,
} from '#client/reload-on-deploy-skew.ts'
import {
	isNavigationLoadArmed,
	isRouterRefreshLoad,
} from '#client/navigation-load.ts'
import {
	deploySkewBuildHeader,
	isDeploySkewMismatch,
} from '#universal/deploy-skew.ts'

/**
 * Compare `X-Kody-Build` to the boot build. On mismatch:
 * - Writes already ran on the server, so they pass through instead of
 *   reporting a failure that invites a duplicate retry.
 * - A same-URL router refresh (after a save or upload) passes through so the
 *   page shows the result and keeps any work in progress.
 * - A navigation read reloads its destination once and never settles, so the
 *   router keeps the current page until the new document commits.
 * - Any other read (tab-return refresh, polling, background refetches) throws
 *   a named recovery error so the page keeps its current data and input.
 * No-ops when either build id is missing (local/dev) or they match.
 */
export async function fetchWithDeploySkewCheck(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const response = await fetch(input, init)
	const serverBuild = response.headers.get(deploySkewBuildHeader)
	if (!serverBuild || !isDeploySkewMismatch(readClientBuildId(), serverBuild)) {
		return response
	}
	const isRead = (init?.method ?? 'GET').toUpperCase() === 'GET'
	if (!isRead || isRouterRefreshLoad()) return response
	if (
		isNavigationLoadArmed() &&
		(reloadOnDeploySkew(serverBuild) || isDeploySkewReloadPending())
	) {
		return new Promise<Response>(() => {})
	}
	throw createDeploySkewRecoveryError()
}
