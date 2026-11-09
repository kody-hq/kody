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
 * Normalize a deploy build id for header/meta/compare. `getEnv` validates but
 * does not transform bindings, so callers must lowercase at the point of use.
 */
export function normalizeDeploySkewBuildId(
	value: string | null | undefined,
): string | null {
	const trimmed = value?.trim().toLowerCase() ?? ''
	// Full object id only: short SHAs must not stamp X-Kody-Build / meta while
	// the client bakes a 40-char define (that pair would always look like skew).
	return /^[a-f0-9]{40}$/.test(trimmed) ? trimmed : null
}

/**
 * True when both sides advertise a build id and they differ. Missing either
 * side is a no-op (local/dev without `APP_COMMIT_SHA`, or pre-skew clients).
 * Comparison is case-insensitive.
 */
export function isDeploySkewMismatch(
	clientBuild: string | null | undefined,
	serverBuild: string | null | undefined,
): boolean {
	const client = normalizeDeploySkewBuildId(clientBuild)
	const server = normalizeDeploySkewBuildId(serverBuild)
	if (!client || !server) return false
	return client !== server
}

/** Session-storage value: one hard navigation per server build + target URL. */
export function deploySkewReloadAttemptKey(
	serverBuild: string,
	href: string,
): string {
	const normalized =
		normalizeDeploySkewBuildId(serverBuild) ?? serverBuild.trim()
	return `${normalized}\n${href}`
}
