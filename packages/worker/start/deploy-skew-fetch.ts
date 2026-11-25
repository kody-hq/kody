/**
 * Start `serverFns.fetch` wrapper that keeps a newer deploy's server-fn
 * payloads away from an older client's components (KODY-DP).
 */

import {
	createDeploySkewRecoveryError,
	readClientBuildId,
	reloadOnDeploySkew,
} from '#client/reload-on-deploy-skew.ts'
import {
	deploySkewBuildHeader,
	isDeploySkewMismatch,
} from '#universal/deploy-skew.ts'

/**
 * Compare `X-Kody-Build` to the boot build. On mismatch during a navigation,
 * reload the destination. Otherwise (tab return refresh, polling, in-place
 * reads) throw a named recovery error so the page keeps its current data and
 * input. Writes already ran on the server, so their responses pass through
 * instead of reporting a failure that invites a duplicate retry. No-ops when
 * either build id is missing (local/dev) or they match.
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
	if (reloadOnDeploySkew(serverBuild)) throw createDeploySkewRecoveryError()
	if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return response
	throw createDeploySkewRecoveryError()
}
