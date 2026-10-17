/** Allow time for publishing paused needs and pinning the reviewed capability set. */
const approvalTimeoutMs = 120_000
export function withApprovalTimeout<TInput, TResult>(
	send: (input: { data: TInput; signal?: AbortSignal }) => Promise<TResult>,
) {
	return (input: { data: TInput }) =>
		send({ ...input, signal: AbortSignal.timeout(approvalTimeoutMs) })
}
