import * as Sentry from '@sentry/cloudflare'
import type { CloudflareOptions } from '@sentry/cloudflare'
import type { BackupEnvironment } from './backup-types.ts'

const workflowStepMechanism = 'auto.faas.cloudflare.workflow'

/**
 * The backup Workflow reports its own failure once, with a DR fingerprint
 * (captureRestExportFailure). Drop the SDK's automatic capture of the same
 * failed step so one failure is one issue.
 */
const dropWorkflowStepException: NonNullable<
	CloudflareOptions['beforeSend']
> = (event) =>
	event.exception?.values?.some(
		(value) => value.mechanism?.type === workflowStepMechanism,
	)
		? null
		: event

export function buildControlPlaneSentryOptions(
	env: BackupEnvironment,
): CloudflareOptions {
	const dsn = env.SENTRY_DSN?.trim()
	const release = env.BUILD_COMMIT?.trim()
	return {
		...(dsn ? { dsn } : {}),
		environment: env.SENTRY_ENVIRONMENT?.trim() || 'production',
		...(release ? { release } : {}),
		tracesSampleRate: 0,
		sendDefaultPii: false,
		beforeSend: dropWorkflowStepException,
	}
}

/**
 * One Sentry issue per DR cause. The fingerprint holds only the cause and its
 * stable detail (source, error code, reason), never the day, so a failure
 * that repeats every night groups into the same issue.
 */
function captureDrIssue(input: {
	cause: string
	detail: string
	message: string
	tags: Record<string, string>
}) {
	Sentry.withScope((scope) => {
		scope.setFingerprint(['dr', input.cause, input.detail])
		scope.setTag('dr.cause', input.cause)
		for (const [key, value] of Object.entries(input.tags)) {
			scope.setTag(key, value)
		}
		Sentry.captureMessage(input.message, 'error')
	})
}

export function captureRestExportFailure(input: {
	databaseName: string
	day: string | undefined
	code: string
}) {
	captureDrIssue({
		cause: 'rest-d1-export-failed',
		detail: `${input.databaseName}:${input.code}`,
		message: `REST D1 export failed for ${input.databaseName}: ${input.code}`,
		tags: {
			'dr.database': input.databaseName,
			'dr.error_code': input.code,
			...(input.day ? { 'dr.day': input.day } : {}),
		},
	})
}

export function captureFullSealBlocked(input: { day: string; reason: string }) {
	captureDrIssue({
		cause: 'full-seal-blocked',
		detail: input.reason,
		message: `Full DR seal is blocked: ${input.reason}`,
		tags: { 'dr.day': input.day, 'dr.seal_reason': input.reason },
	})
}
