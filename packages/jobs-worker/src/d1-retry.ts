import { type ErrorEvent } from '@sentry/core'
import { isBareRetryableD1LockSentryEvent } from '@kody-internal/shared/d1-retry.ts'

export * from '@kody-internal/shared/d1-retry.ts'

/**
 * Drop only when every reported Sentry message/exception value is a bare D1
 * platform blip (same semantics as the main worker helper). Anchored/exact
 * matching so wrappers that embed lock/export/reset text stay visible.
 */
export function isRetryableD1LockSentryEvent(event: ErrorEvent) {
	return isBareRetryableD1LockSentryEvent(event)
}
