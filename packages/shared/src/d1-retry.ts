import { errorCauseChainIncludes } from './error-message.ts'

export const d1LockRetryMaxAttempts = 6

export const d1LockRetryBaseDelayMs = 150

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Cloudflare D1 emits this while a REST/API export is in progress. Exports
 * block other database requests for consistency (see D1 import/export docs),
 * so production MCP/cron traffic fails for the duration of the nightly DR
 * backup export. Same class of transient unavailability as SQLITE_BUSY.
 */
export const d1LongRunningExportMessage =
	'Currently processing a long-running export'

/**
 * Cloudflare D1 binding transport blip (`D1_ERROR: Network connection lost.`).
 * Not an application defect — the Worker lost its session to D1 mid-query.
 * Same retry / Sentry-drop class as SQLITE_BUSY and long-running exports.
 * Match only the exact D1 forms (optional `Error:` / `D1_ERROR:` prefixes) so
 * unrelated "Network connection lost while …" messages stay out.
 */
export const d1NetworkConnectionLostMessage = 'Network connection lost'

/**
 * Cloudflare D1 capacity blips. Two exact platform phrasings exist:
 * - `D1_ERROR: D1 DB is overloaded. Requests queued for too long.`
 * - `D1_ERROR: D1 DB is overloaded. Too many requests queued.`
 * Not an application defect — D1's request queue timed out or rejected under
 * platform load. Same retry / Sentry-drop class as SQLITE_BUSY and binding
 * transport blips. Match only these exact D1 forms (optional `Error:` /
 * `D1_ERROR:` prefixes) so unrelated "… overloaded …" messages stay out.
 */
export const d1DbOverloadedMessage =
	'D1 DB is overloaded. Requests queued for too long'

export const d1DbOverloadedTooManyQueuedMessage =
	'D1 DB is overloaded. Too many requests queued'

/**
 * Cloudflare D1 opaque platform failures with a support reference, e.g.
 * `D1_ERROR: internal error; reference = <id>`,
 * `D1_ERROR: Internal error in D1 DB storage caused object to be reset; reference = <id>`,
 * `D1_ERROR: Internal error in Durable Object storage caused object to be
 * reset; reference = <id>` (KODY-82 — D1 is DO-backed; the binding can surface
 * either storage phrasing), and the startup variant
 * `Internal error while starting up Durable Object storage caused object to be
 * reset; reference = <id>` (KODY-95 — same DO-storage-reset family; D1 DB
 * storage may use the same `in` / `while starting up` alternation). Not an
 * application defect — D1's storage/backend hit an internal fault. Same retry
 * / Sentry-drop class as SQLITE_BUSY and binding transport blips. Require the
 * `reference =` token and only these known phrasings so bare "internal error"
 * (or unrelated "internal error while …") from app code stays non-retryable
 * and Sentry-visible. Cloudflare reference ids are alphanumeric and may
 * include `_` or `-`.
 */
const d1InternalErrorReferencePattern =
	/^internal error(?: (?:in|while starting up) (?:D1 DB|Durable Object) storage caused object to be reset)?;\s*reference\s*=\s*[A-Za-z0-9_-]+$/i

/**
 * Exact Durable Object platform-reset sentences D1 can surface under optional
 * `Error:` / `D1_ERROR:` prefixes (KODY-A9 — D1 is DO-backed; a deploy of the
 * backing isolate yields `D1_ERROR: Durable Object reset because its code was
 * updated.`). Same family as the worker Sentry / DO-reset-retry matchers:
 * code-updated, blockConcurrencyWhile / storage-op timeouts, instance-inactive
 * RPC close, and isolate memory/CPU / SQLITE_NOMEM resource-limit resets.
 * Match only these bare platform strings so wrappers that embed the sentence
 * stay non-retryable and Sentry-visible. Trailing periods are optional via
 * {@link isExactD1PlatformMessage}.
 */
const d1DurableObjectPlatformResetMessages = [
	'Durable Object reset because its code was updated',
	'A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset',
	'Durable Object storage operation exceeded timeout which caused object to be reset',
	'Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request',
	"Durable Object's isolate exceeded its memory limit and was reset",
	'Durable Object exceeded its CPU time limit and was reset',
	'out of memory: SQLITE_NOMEM',
] as const

function stripD1ErrorPrefixes(message: string) {
	return message
		.trim()
		.replace(/^Error:\s*/i, '')
		.replace(/^D1_ERROR:\s*/i, '')
}

function isExactD1PlatformMessage(message: string, expected: string) {
	const normalized = stripD1ErrorPrefixes(message)
	return normalized === expected || normalized === `${expected}.`
}

function isD1NetworkConnectionLostMessage(message: string) {
	return isExactD1PlatformMessage(message, d1NetworkConnectionLostMessage)
}

function isD1DbOverloadedMessage(message: string) {
	return (
		isExactD1PlatformMessage(message, d1DbOverloadedMessage) ||
		isExactD1PlatformMessage(message, d1DbOverloadedTooManyQueuedMessage)
	)
}

function isD1InternalErrorMessage(message: string) {
	return d1InternalErrorReferencePattern.test(stripD1ErrorPrefixes(message))
}

function isD1DurableObjectPlatformResetMessage(message: string) {
	return d1DurableObjectPlatformResetMessages.some((expected) =>
		isExactD1PlatformMessage(message, expected),
	)
}

/**
 * Bare D1 lock / export platform sentences after stripping `Error:` /
 * `D1_ERROR:` prefixes. Anchored so recovery wrappers that embed
 * `SQLITE_BUSY` / `database is locked` / the export phrase (for example
 * rebuild failure messages) stay non-matching for Sentry drops while retries
 * still use the substring predicate below. Optional `(extended: SQLITE_BUSY_…)`
 * matches the same SQLite extended-result suffix D1 appends on constraint
 * failures elsewhere in this repo.
 */
const d1BareLockMessagePattern =
	/^(?:NOSENTRY\s+)?database is locked(?::\s*SQLITE_BUSY(?:\s*\(extended:\s*SQLITE_BUSY_[A-Z0-9_]+\))?)?$/i

function isD1BareLockMessage(message: string) {
	return d1BareLockMessagePattern.test(stripD1ErrorPrefixes(message))
}

function isD1BareLongRunningExportMessage(message: string) {
	return isExactD1PlatformMessage(message, d1LongRunningExportMessage)
}

/**
 * Exact / anchored D1 platform blips only. Used by Sentry `beforeSend` so a
 * wrapper that embeds a lock/export/reset sentence does not count as a bare
 * platform message. Retries keep {@link isRetryableD1LockMessage}.
 */
export function isBareRetryableD1LockMessage(message: string) {
	return (
		isD1BareLockMessage(message) ||
		isD1BareLongRunningExportMessage(message) ||
		isD1NetworkConnectionLostMessage(message) ||
		isD1DbOverloadedMessage(message) ||
		isD1InternalErrorMessage(message) ||
		isD1DurableObjectPlatformResetMessage(message)
	)
}

/**
 * D1 storage unavailability only: lock, long-running export, binding
 * transport, overload, and opaque internal-error blips. Excludes Durable
 * Object platform-reset sentences that also match
 * {@link isRetryableD1LockMessage} because D1 is DO-backed — callers that
 * need a longer export backoff or Sentry remap must not treat a bare
 * code-updated reset as an export-class blip.
 */
export function isRetryableD1StorageUnavailabilityMessage(message: string) {
	return (
		message.includes('SQLITE_BUSY') ||
		message.includes('database is locked') ||
		message.includes(d1LongRunningExportMessage) ||
		isD1NetworkConnectionLostMessage(message) ||
		isD1DbOverloadedMessage(message) ||
		isD1InternalErrorMessage(message)
	)
}

export function isRetryableD1LockMessage(message: string) {
	return (
		isRetryableD1StorageUnavailabilityMessage(message) ||
		isD1DurableObjectPlatformResetMessage(message)
	)
}

export function isRetryableD1LockError(error: unknown) {
	return errorCauseChainIncludes(error, isRetryableD1LockMessage)
}

export function isRetryableD1StorageUnavailabilityError(error: unknown) {
	return errorCauseChainIncludes(
		error,
		isRetryableD1StorageUnavailabilityMessage,
	)
}

/**
 * Opt-in per-attempt deadline for `runD1WithRetry`. Idle D1 bindings can hang
 * instead of throwing a retryable platform error; a bounded attempt lets the
 * next try run before an outer health-check timeout fires.
 */
export class D1AttemptTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`D1 attempt timed out after ${timeoutMs}ms`)
		this.name = 'D1AttemptTimeoutError'
	}
}

function isD1AttemptTimeoutError(error: unknown) {
	return error instanceof D1AttemptTimeoutError
}

function withAttemptTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const handle = setTimeout(() => {
			reject(new D1AttemptTimeoutError(timeoutMs))
		}, timeoutMs)
		operation.then(
			(value) => {
				clearTimeout(handle)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(handle)
				reject(error)
			},
		)
	})
}

/**
 * Retries transient D1 unavailability: SQLITE_BUSY lock contention,
 * Cloudflare's "Currently processing a long-running export" (DR / REST
 * exports block other requests), binding "Network connection lost"
 * transport blips, "D1 DB is overloaded. Requests queued for too long" /
 * "D1 DB is overloaded. Too many requests queued" capacity blips, opaque
 * D1 "internal error …; reference = …" platform faults (including D1 DB and
 * Durable Object storage object-reset, with either `in` or `while starting up`
 * phrasing), and D1-prefixed Durable Object platform-reset sentences such as
 * "Durable Object reset because its code was updated" (KODY-A9 — D1 is
 * DO-backed). D1 does not automatically retry write queries, so cron lanes and
 * long-running retention batches need application-level backoff when they
 * overlap with concurrent writers, an in-flight export, a brief D1 session
 * drop, a D1 capacity spike, or a D1 backend blip.
 *
 * When `attemptTimeoutMs` is set, a hung attempt is also retried so a single
 * idle-database stall cannot consume an outer deadline.
 */
export async function runD1WithRetry<T>(
	operation: () => Promise<T>,
	options?: {
		maxAttempts?: number
		baseDelayMs?: number
		attemptTimeoutMs?: number
	},
): Promise<T> {
	const maxAttempts = options?.maxAttempts ?? d1LockRetryMaxAttempts
	const baseDelayMs = options?.baseDelayMs ?? d1LockRetryBaseDelayMs
	const attemptTimeoutMs = options?.attemptTimeoutMs
	let lastError: unknown
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = operation()
			return attemptTimeoutMs === undefined
				? await result
				: await withAttemptTimeout(result, attemptTimeoutMs)
		} catch (error) {
			lastError = error
			const retryable =
				isRetryableD1LockError(error) ||
				(attemptTimeoutMs !== undefined && isD1AttemptTimeoutError(error))
			if (!retryable || attempt === maxAttempts) {
				throw error
			}
			await sleep(baseDelayMs * 2 ** (attempt - 1))
		}
	}
	throw lastError
}
