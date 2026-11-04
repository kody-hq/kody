/**
 * One-shot hard navigation when a stale tab's server-fn response advertises a
 * newer `APP_COMMIT_SHA` than the document boot build (KODY-DP / issue
 * 7828247968). Mirrors `reload-on-unknown-start-release.ts`: set a session
 * flag before navigating, clear after a successful boot so a later deploy can
 * recover again. Only one attempt per server-build + target URL.
 */

import {
	deploySkewBuildMetaName,
	deploySkewReloadAttemptKey,
	isDeploySkewMismatch,
	normalizeDeploySkewBuildId,
} from '#universal/deploy-skew.ts'
import {
	getSessionStorageItem,
	setSessionStorageItem,
} from '#client/session-storage-access.ts'

export const deploySkewReloadFlag = 'kody:deploy-skew-reload'

export const deploySkewRecoveryErrorName = 'DeploySkewRecovery'

/** Cached at first successful resolve so SPA head updates cannot hide skew. */
let cachedClientBuildId: string | null | undefined

/** Test-only override for the Vite define (undefined = use real define). */
let bakedClientBuildIdForTests: string | null | undefined

/** Test helper: drop the boot-time build cache between cases. */
export function resetDeploySkewClientBuildCache(): void {
	cachedClientBuildId = undefined
	bakedClientBuildIdForTests = undefined
}

/** Test helper: stub the Vite-baked commit without relying on globals. */
export function setBakedClientBuildIdForTests(
	value: string | null | undefined,
): void {
	bakedClientBuildIdForTests = value
	cachedClientBuildId = undefined
}

/**
 * Vite-baked commit SHA (production/preview builds). Empty string locally /
 * when the define is unset. Only full 40-char object ids count — short SHAs
 * would false-positive against a full `X-Kody-Build` header.
 */
export function readBakedClientBuildId(): string | null {
	if (bakedClientBuildIdForTests !== undefined) {
		const trimmed = bakedClientBuildIdForTests?.trim().toLowerCase() ?? ''
		return /^[a-f0-9]{40}$/.test(trimmed) ? trimmed : null
	}
	try {
		const trimmed = __KODY_APP_COMMIT_SHA__.trim().toLowerCase()
		return /^[a-f0-9]{40}$/.test(trimmed) ? trimmed : null
	} catch {
		return null
	}
}

/**
 * Commit SHA this client bundle / document booted with. Prefer the Vite-baked
 * define (available even on failure documents with no root loader meta), then
 * fall back to `<meta name="kody:build">`. Cache only after a successful
 * resolve so a missing meta on an early error document cannot permanently
 * disable skew recovery.
 */
export function readClientBuildId(
	doc: Pick<Document, 'querySelector'> | null | undefined = typeof document ===
	'undefined'
		? null
		: document,
): string | null {
	if (cachedClientBuildId !== undefined) return cachedClientBuildId
	const baked = readBakedClientBuildId()
	if (baked) {
		cachedClientBuildId = baked
		return baked
	}
	if (!doc) return null
	const content = normalizeDeploySkewBuildId(
		doc
			.querySelector(`meta[name="${deploySkewBuildMetaName}"]`)
			?.getAttribute('content'),
	)
	if (content) {
		cachedClientBuildId = content
		return content
	}
	return null
}

export function isDeploySkewRecoveryError(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false
	if (!('name' in error) || typeof error.name !== 'string') return false
	return error.name === deploySkewRecoveryErrorName
}

export function createDeploySkewRecoveryError(): Error {
	return Object.assign(new Error('Deploy skew recovery'), {
		name: deploySkewRecoveryErrorName,
	})
}

/**
 * If the server build differs from the boot client build, hard-navigate to
 * `href` once for this build+URL pair. Returns whether navigation was
 * triggered. Never throws when sessionStorage is unavailable (and does not
 * navigate in that case, to avoid a loop with no flag).
 */
export function reloadOnDeploySkew(input: {
	serverBuild: string
	href: string
}): boolean {
	const clientBuild = readClientBuildId()
	if (!isDeploySkewMismatch(clientBuild, input.serverBuild)) return false
	if (typeof window === 'undefined') return false
	const href = input.href.trim()
	if (!href) return false
	const attempt = deploySkewReloadAttemptKey(input.serverBuild, href)
	try {
		if (getSessionStorageItem(deploySkewReloadFlag) === attempt) return false
		if (!setSessionStorageItem(deploySkewReloadFlag, attempt)) return false
		window.location.assign(href)
		return true
	} catch {
		return false
	}
}

/** Best-effort clear after a successful client boot (mirrors boot-chunk). */
export function clearDeploySkewReloadFlag(): void {
	try {
		sessionStorage.removeItem(deploySkewReloadFlag)
	} catch {
		// Storage may be unavailable (private mode); clearing is best-effort.
	}
}
