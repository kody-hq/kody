/**
 * Package-invocation error codes that indicate infrastructure trouble
 * rather than a user-code failure. Neutral module (no service imports) so
 * dispatchers like subscription-dispatch can classify responses without
 * creating an import cycle through admin-package-subscriptions → service.
 */
export const durableObjectResetInvocationErrorCode = 'durable_object_reset'

const retryablePackageInvocationInfrastructureCodes = new Set([
	'idempotency_lookup_failed',
	'idempotency_persistence_failed',
	'idempotency_conflict_unresolved',
	'invocation_in_progress',
	'invocation_failed',
	'idempotency_response_unavailable',
	'artifact_preparation_failed',
	durableObjectResetInvocationErrorCode,
])

/** Codes raised before user code ran, so Queue redelivery re-executes. */
const preExecutionPackageInvocationInfrastructureCodes = new Set([
	'idempotency_lookup_failed',
	'idempotency_persistence_failed',
	'idempotency_conflict_unresolved',
	'invocation_in_progress',
	'artifact_preparation_failed',
])

function readPackageInvocationInfrastructureCode(input: {
	response: {
		status: number
		body: Record<string, unknown>
	}
	codes: ReadonlySet<string>
}) {
	if (input.response.status >= 200 && input.response.status < 300) return null
	const error = input.response.body['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) return null
	const code = (error as Record<string, unknown>)['code']
	return typeof code === 'string' && input.codes.has(code) ? code : null
}

export function readRetryablePackageInvocationInfrastructureCode(response: {
	status: number
	body: Record<string, unknown>
}) {
	return readPackageInvocationInfrastructureCode({
		response,
		codes: retryablePackageInvocationInfrastructureCodes,
	})
}

export function readPreExecutionPackageInvocationInfrastructureCode(response: {
	status: number
	body: Record<string, unknown>
}) {
	return readPackageInvocationInfrastructureCode({
		response,
		codes: preExecutionPackageInvocationInfrastructureCodes,
	})
}
