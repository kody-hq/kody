import { type ErrorEvent, type EventHint } from '@sentry/core'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	isBareRetryableD1LockMessage,
	isRetryableD1StorageUnavailabilityError,
} from '@kody-internal/shared/d1-retry.ts'

export * from '@kody-internal/shared/d1-retry.ts'

/**
 * Public Open API / MCP message when D1 platform blips outlive storage
 * retries (in-flight export, overload, opaque platform faults). Kept here so
 * Sentry remap matching and `toApiError` share one string.
 */
export const transientDatabaseUnavailableMessage =
	'Kody storage was briefly unavailable. Retry in a few seconds.'

/**
 * Exhausted published-artifact rebuild wrapper (KODY-AP). MCP `api` captures
 * this original error (not the remapped ApiError); Open API remaps it to
 * {@link transientDatabaseUnavailableMessage} when the cause chain is a
 * retryable D1 lock/export blip.
 */
const rebuildExhaustedTransientPlatformAttemptsPattern =
	/^rebuildPublishedPackageArtifactsViaRepoSession could not recover after \d+ transient platform error attempts:/

/**
 * True when Open API / Sentry should treat this as an exhausted D1 storage
 * transient (KODY-AP). Parallel to `isArtifactsGitTransientRemapError`
 * (KODY-8P): require a D1 storage-unavailability marker (lock/export/
 * overload/internal — not DO code-updated resets), and a known remap /
 * rebuild-exhaustion top message. Bare event-message filtering stays
 * anchored so unrelated recovery wrappers that merely nest a D1 cause stay
 * Sentry-visible (#3859).
 */
export function isRetryableD1LockRemapError(error: unknown) {
	if (!isRetryableD1StorageUnavailabilityError(error)) return false
	const top = getErrorMessage(error)
	if (top === transientDatabaseUnavailableMessage) return true
	return rebuildExhaustedTransientPlatformAttemptsPattern.test(top)
}

export function isRetryableD1LockSentryEvent(
	event: ErrorEvent,
	hint?: EventHint,
) {
	if (isRetryableD1LockRemapError(hint?.originalException)) return true
	const messages = [
		event.message,
		...(event.exception?.values?.map((value) => value.value) ?? []),
	].filter(
		(message): message is string =>
			typeof message === 'string' && message.trim().length > 0,
	)
	// Drop only when every reported message is a bare D1 platform blip.
	// Use the anchored/exact predicate (not the substring retry matcher) so
	// rebuild/recovery wrappers that embed SQLITE_BUSY, export, or reset text
	// stay Sentry-visible even when the cause is a matching D1 blip — unless
	// `hint.originalException` matches {@link isRetryableD1LockRemapError}.
	return (
		messages.length > 0 &&
		messages.every((message) => isBareRetryableD1LockMessage(message))
	)
}
