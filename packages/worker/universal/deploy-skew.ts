/**
 * Deploy version skew: an old client tab calling new Start server functions
 * after a deploy (KODY-DP / issue 7828247968). Shared names and pure mismatch
 * checks — no DOM, no storage.
 */

/** Response header stamped on Start server-fn replies with `APP_COMMIT_SHA`. */
export const deploySkewBuildHeader = 'X-Kody-Build'

/** Document meta baked at SSR with the commit the client document/boot used. */
export const deploySkewBuildMetaName = 'kody:build'

/**
 * True when both sides advertise a build id and they differ. Missing either
 * side is a no-op (local/dev without `APP_COMMIT_SHA`, or pre-skew clients).
 */
export function isDeploySkewMismatch(
	clientBuild: string | null | undefined,
	serverBuild: string | null | undefined,
): boolean {
	const client = clientBuild?.trim() ?? ''
	const server = serverBuild?.trim() ?? ''
	if (!client || !server) return false
	return client !== server
}

/** Session-storage value: one hard navigation per server build + target URL. */
export function deploySkewReloadAttemptKey(
	serverBuild: string,
	href: string,
): string {
	return `${serverBuild.trim()}\n${href}`
}
