import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'

/**
 * Cloudflare Artifacts git protocol (`info/refs`, upload-pack) occasionally
 * returns 5xx / 429 after REST createToken + repo info already succeeded
 * (KODY-CLOUDFLARE-4Y / 4Z / 50). Short retries paper over the blip without
 * treating it as an application defect.
 *
 * The same hop can also stall with no status (isomorphic-git's web client
 * does not abort `fetch`). A deadline error is transient for the same
 * reason: retry, then surface the timeout instead of holding the caller
 * until the MCP client gives up.
 *
 * Separately, upload-pack sometimes returns HTTP 200 with a truncated or
 * corrupt pack body; isomorphic-git then throws InternalError containing
 * "Packfile payload corrupted" when verifying the pack on first
 * readObjectPacked / readBlob (not during fetch itself)
 * (KODY-CLOUDFLARE-55 / 56). Same retry + wrap treatment — never an
 * app-logic defect we can fix in-repo. Call sites that fetch then read
 * must keep both steps inside `runArtifactsGitWithRetry`.
 */
export const artifactsGitHttpRetryDelaysMs = [50, 150] as const

/**
 * Status class for exhausted Artifacts git failures after call-site retries.
 * Keep free of remotes and hosts — Open API `details` and user-facing
 * messages use these labels only.
 */
export type ArtifactsGitExhaustedStatusClass =
	| 'http_5xx'
	| 'http_429'
	| 'packfile_corruption'
	| 'timeout'
	| 'missing_object'
	| 'unknown'

/**
 * Legacy constant kept for message-substring detectors (for example vendor
 * outage heuristics). Prefer `ArtifactsGitUnavailableError` / `toApiError`
 * for new call sites — exhausted failures no longer tell callers to retry.
 * Permanent: usernames created before the DNS-label rule keep working.
 */
export const artifactsGitTemporarilyUnavailableMessage =
	'The package source is temporarily unavailable. Retry the call.'

const artifactsGitWrappedFailureMessagePattern =
	/^Artifacts (?:listServerRefs|git fetch|git clone) failed for /i

/**
 * User-facing message when Artifacts git failed after retries (or failed in a
 * way retries cannot fix). Includes a report id and a coarse upstream class so
 * bug reports can be traced without leaking remotes or hosts.
 */
export function buildArtifactsGitUnavailableMessage(input: {
	reportId: string
	statusClass: ArtifactsGitExhaustedStatusClass
}) {
	const classLabel = artifactsGitStatusClassLabel(input.statusClass)
	return `The package source could not be read after retries (${classLabel}). Report id: ${input.reportId}.`
}

export function artifactsGitStatusClassLabel(
	statusClass: ArtifactsGitExhaustedStatusClass,
) {
	switch (statusClass) {
		case 'http_5xx':
			return 'HTTP 5xx'
		case 'http_429':
			return 'HTTP 429'
		case 'packfile_corruption':
			return 'corrupt pack'
		case 'timeout':
			return 'read timeout'
		case 'missing_object':
			return 'missing object or ref'
		case 'unknown':
			return 'storage read failure'
		default: {
			const exhaustive: never = statusClass
			throw new Error(
				`Unhandled Artifacts git status class: ${String(exhaustive)}`,
			)
		}
	}
}

export function isArtifactsGitMissingObjectMessage(message: string) {
	return (
		/Could not find\b/i.test(message) ||
		/\bOID\b.*\bnot found\b/i.test(message) ||
		/\bnot a valid\b.*\boid\b/i.test(message) ||
		/\bNo such ref\b/i.test(message) ||
		/\bFailed to resolve\b.*\bref\b/i.test(message)
	)
}

export function isArtifactsGitMissingObjectError(error: unknown) {
	for (const entry of getErrorCauseChain(error)) {
		if (!(entry instanceof Error)) continue
		if (
			'code' in entry &&
			typeof entry.code === 'string' &&
			['NotFoundError', 'ResolveTreeError'].includes(entry.code)
		) {
			return true
		}
		if (isArtifactsGitMissingObjectMessage(entry.message)) return true
	}
	return false
}

export function isArtifactsGitWrappedFailureMessage(message: string) {
	return artifactsGitWrappedFailureMessagePattern.test(message.trim())
}

export function isArtifactsGitWrappedFailureError(error: unknown) {
	return getErrorCauseChain(error).some(
		(entry) =>
			entry instanceof Error &&
			isArtifactsGitWrappedFailureMessage(entry.message),
	)
}

export function classifyArtifactsGitExhaustedFailure(error: unknown): {
	statusClass: ArtifactsGitExhaustedStatusClass
	httpStatus: number | null
} {
	const httpStatus = getArtifactsGitHttpStatus(error)
	if (isIsomorphicGitPackfileCorruptionError(error)) {
		return { statusClass: 'packfile_corruption', httpStatus }
	}
	if (isArtifactsGitTimeoutError(error)) {
		return { statusClass: 'timeout', httpStatus }
	}
	if (isArtifactsGitMissingObjectError(error)) {
		return { statusClass: 'missing_object', httpStatus }
	}
	if (httpStatus === 429) {
		return { statusClass: 'http_429', httpStatus }
	}
	if (httpStatus != null && httpStatus >= 500 && httpStatus <= 599) {
		return { statusClass: 'http_5xx', httpStatus }
	}
	return { statusClass: 'unknown', httpStatus }
}

/**
 * Remapped exhausted Artifacts git failure for Open API / MCP / website
 * install. Keeps `internal_error` + HTTP 503 (closed client contract) while
 * putting a report id and upstream status class in the message and details.
 */
export class ArtifactsGitUnavailableError extends Error {
	readonly reportId: string
	readonly statusClass: ArtifactsGitExhaustedStatusClass
	readonly httpStatus: number | null

	constructor(cause: unknown, reportId: string = crypto.randomUUID()) {
		const classified = classifyArtifactsGitExhaustedFailure(cause)
		super(
			buildArtifactsGitUnavailableMessage({
				reportId,
				statusClass: classified.statusClass,
			}),
			{ cause },
		)
		this.name = 'ArtifactsGitUnavailableError'
		this.reportId = reportId
		this.statusClass = classified.statusClass
		this.httpStatus = classified.httpStatus
	}

	toApiDetails() {
		return {
			report_id: this.reportId,
			upstream_status_class: this.statusClass,
			...(this.httpStatus != null ? { upstream_status: this.httpStatus } : {}),
		}
	}
}

export function toArtifactsGitUnavailableError(
	error: unknown,
): ArtifactsGitUnavailableError {
	if (error instanceof ArtifactsGitUnavailableError) return error
	const unavailable = new ArtifactsGitUnavailableError(error)
	// Minted report ids must appear in server logs so bug reports can be traced
	// (Open API logs the original error before remap; website install does too).
	console.error(
		JSON.stringify({
			message: 'artifacts-git-unavailable',
			reportId: unavailable.reportId,
			statusClass: unavailable.statusClass,
			httpStatus: unavailable.httpStatus,
			cause: getErrorMessage(error),
		}),
	)
	return unavailable
}

export function isTransientArtifactsGitHttpStatus(status: number) {
	return (
		status === 429 ||
		status === 500 ||
		status === 502 ||
		status === 503 ||
		status === 504
	)
}

function readHttpStatusFromErrorData(error: unknown): number | null {
	if (!error || typeof error !== 'object' || !('data' in error)) return null
	const data = (error as { data?: { statusCode?: unknown } }).data
	return data && typeof data.statusCode === 'number' ? data.statusCode : null
}

function readHttpStatusFromMessage(message: string): number | null {
	const match = /HTTP Error: (\d{3})\b/i.exec(message)
	if (!match?.[1]) return null
	return Number(match[1])
}

export function getArtifactsGitHttpStatus(error: unknown): number | null {
	for (const entry of getErrorCauseChain(error)) {
		const fromData = readHttpStatusFromErrorData(entry)
		if (fromData != null) return fromData
		if (entry instanceof Error) {
			const fromMessage = readHttpStatusFromMessage(entry.message)
			if (fromMessage != null) return fromMessage
		}
	}
	return null
}

export function isTransientArtifactsGitHttpError(error: unknown) {
	const status = getArtifactsGitHttpStatus(error)
	return status != null && isTransientArtifactsGitHttpStatus(status)
}

/**
 * isomorphic-git integrity failure while unpacking a remote pack. The phrase
 * is unique to that check; match it anywhere in the cause chain so HTTP-200
 * corrupt packs and 5xx-interrupted uploads both retry.
 */
export function isIsomorphicGitPackfileCorruptionMessage(message: string) {
	return /Packfile payload corrupted/i.test(message)
}

export function isIsomorphicGitPackfileCorruptionError(error: unknown) {
	for (const entry of getErrorCauseChain(error)) {
		if (
			entry instanceof Error &&
			isIsomorphicGitPackfileCorruptionMessage(entry.message)
		) {
			return true
		}
	}
	return false
}

/**
 * Deadline fired around an Artifacts git HTTP request. Matches the wrapper
 * thrown by the bounded git client and a raw `AbortSignal.timeout`
 * `TimeoutError` if one escapes unwrapped.
 */
export function isArtifactsGitTimeoutError(error: unknown) {
	for (const entry of getErrorCauseChain(error)) {
		if (!(entry instanceof Error)) continue
		if (
			entry.name === 'ArtifactsGitTimeoutError' ||
			entry.name === 'TimeoutError'
		) {
			return true
		}
		if (isArtifactsGitTimeoutMessage(entry.message)) {
			return true
		}
	}
	return false
}

export function isTransientArtifactsGitError(error: unknown) {
	return (
		isTransientArtifactsGitHttpError(error) ||
		isIsomorphicGitPackfileCorruptionError(error) ||
		isArtifactsGitTimeoutError(error)
	)
}

/**
 * Stable wrapper phrases used by Artifacts git call sites and the Sentry
 * beforeSend filter. Keep these exact so triage filters stay narrow, and keep
 * the status set aligned with `isTransientArtifactsGitHttpStatus` so we do not
 * drop un-retried failures (e.g. HTTP 501) from Sentry.
 */
export function isArtifactsGitTransientHttpErrorMessage(message: string) {
	const match =
		/Artifacts (?:listServerRefs|git fetch|git clone) failed for .+: HTTP Error: (\d{3})\b/i.exec(
			message.trim(),
		)
	if (!match?.[1]) return false
	return isTransientArtifactsGitHttpStatus(Number(match[1]))
}

/**
 * Drop Sentry events for Artifacts pack corruption whether or not a call site
 * wrapped them. The phrase is never produced by application logic — only by
 * isomorphic-git verifying a remote pack — so bare InternalError events from
 * `git.clone` paths are safe to filter the same way as wrapped ones.
 */
export function isArtifactsGitPackfileCorruptionSentryMessage(message: string) {
	return isIsomorphicGitPackfileCorruptionMessage(message)
}

export function isArtifactsGitTransientErrorMessage(message: string) {
	return (
		isArtifactsGitTransientHttpErrorMessage(message) ||
		isArtifactsGitPackfileCorruptionSentryMessage(message) ||
		isArtifactsGitTimeoutMessage(message)
	)
}

export function isArtifactsGitTimeoutMessage(message: string) {
	return /Artifacts git request timed out after \d+ms/.test(message)
}

/**
 * True when Open API / Sentry should treat this as an exhausted Artifacts git
 * transient (KODY-8P). Requires an Artifacts-specific marker in the cause
 * chain — wrapper HTTP phrase, packfile phrase, `ArtifactsGitTimeoutError`,
 * or the Artifacts timeout message — not a bare `TimeoutError` or a nested
 * `HTTP Error: NNN` under an unrelated outer failure. Source-recovery stop
 * guidance anywhere in the cause chain is never remapped (including after
 * `toApiError` wraps the recovery error as a generic `ApiError`).
 */
export function isArtifactsGitTransientRemapError(error: unknown) {
	const chain = getErrorCauseChain(error)
	if (chain.length === 0) return false
	if (
		chain.some((entry) =>
			getErrorMessage(entry).includes(
				'Stop and report this source recovery problem',
			),
		)
	) {
		return false
	}
	return chain.some((entry) => {
		if (!(entry instanceof Error)) return false
		if (isArtifactsGitTransientHttpErrorMessage(entry.message)) return true
		if (isIsomorphicGitPackfileCorruptionMessage(entry.message)) return true
		if (entry.name === 'ArtifactsGitTimeoutError') return true
		if (isArtifactsGitTimeoutMessage(entry.message)) return true
		return false
	})
}

function describeArtifactRemote(remote: string) {
	try {
		const url = new URL(remote)
		url.username = ''
		url.password = ''
		url.search = ''
		url.hash = ''
		return url.toString()
	} catch {
		return 'unparseable-remote'
	}
}

export function wrapArtifactsGitHttpError(input: {
	operation: 'listServerRefs' | 'git fetch' | 'git clone'
	remote: string
	error: unknown
}) {
	return new Error(
		`Artifacts ${input.operation} failed for ${describeArtifactRemote(input.remote)}: ${getErrorMessage(input.error)}`,
		{ cause: input.error },
	)
}

function waitForArtifactsGitRetry(delayMs: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

export async function runArtifactsGitWithRetry<T>(
	operation: () => Promise<T>,
	delaysMs: ReadonlyArray<number> = artifactsGitHttpRetryDelaysMs,
): Promise<T> {
	let lastError: unknown
	const maxAttempts = delaysMs.length + 1
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		try {
			return await operation()
		} catch (error) {
			lastError = error
			const canRetry =
				isTransientArtifactsGitError(error) && attempt < maxAttempts - 1
			if (!canRetry) throw error
			const delayMs = delaysMs[attempt]
			if (delayMs !== undefined && delayMs > 0) {
				await waitForArtifactsGitRetry(delayMs)
			}
		}
	}
	throw lastError ?? new Error('Artifacts git operation failed after retries')
}
