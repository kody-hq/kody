/**
 * Console + Sentry reporting when an org audit write fails after the caller
 * already got its result. The console line is an identifier only: D1 errors
 * can include bound parameters, so the exception object stays out of logs.
 */
import * as Sentry from '@sentry/cloudflare'

export function reportOrgAuditWriteFailure(
	message: string,
	event: { action: string; orgId: string; result: string },
	error: unknown,
) {
	console.error(message, {
		action: event.action,
		orgId: event.orgId,
		result: event.result,
		errorName: error instanceof Error ? error.name : typeof error,
	})
	Sentry.withScope((scope) => {
		scope.setTag('org_audit.action', event.action)
		scope.setContext('org_audit', {
			action: event.action,
			orgId: event.orgId,
			result: event.result,
		})
		Sentry.captureException(error)
	})
}
