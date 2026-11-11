import type { AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'

/** Allow time for publishing paused needs and pinning the reviewed capability set. */
const approvalTimeoutMs = 120_000
export function withApprovalTimeout<TInput, TResult>(
	send: (input: { data: TInput; signal?: AbortSignal }) => Promise<TResult>,
) {
	return (input: { data: TInput }) =>
		send({ ...input, signal: AbortSignal.timeout(approvalTimeoutMs) })
}

/**
 * The browser gave up, but the server keeps going, so a timeout is not a
 * failure. Never ask for a retry: a second approve can race the first.
 */
export const approvalStillRunningMessage =
	'This is taking longer than expected. Reload to see whether it went through.'

export function isApprovalTimeout(error: unknown) {
	return error instanceof DOMException && error.name === 'TimeoutError'
}

/** After a timeout: the re-read page no longer lists this request as pending. */
export function pendingApprovalLanded(
	payload: AccountPackageApproveCapabilitiesLoaderData,
	requestId: string,
) {
	return !(payload.pendingApprovals ?? []).some(
		(approval) => approval.id === requestId,
	)
}

/** After a timeout: the re-read page shows the reviewed set approved. */
export function capabilityApprovalLanded(
	payload: AccountPackageApproveCapabilitiesLoaderData,
	input: { fingerprint: string; goPublicRequestId: string | null },
) {
	return (
		payload.fingerprintMatchesApproval &&
		payload.fingerprint === input.fingerprint &&
		(input.goPublicRequestId === null || payload.package.isInternetVisible)
	)
}
