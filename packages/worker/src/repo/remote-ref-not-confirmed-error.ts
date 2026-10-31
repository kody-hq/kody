/**
 * Thrown when a git push returned success but the Artifacts remote does not
 * advertise the pushed commit at the target ref. Publish paths must treat this
 * as "nothing was published": the caller keeps its session (and its local
 * commits) so the push can be retried, and no published pointer moves.
 */
export class RemoteRefNotConfirmedError extends Error {
	readonly ref: string
	readonly expectedCommit: string
	readonly observedCommit: string | null

	constructor(input: {
		ref: string
		expectedCommit: string
		observedCommit: string | null
		cause?: unknown
	}) {
		super(
			`The source repo did not confirm the push: ${input.ref} is at ${input.observedCommit ?? 'no commit'}, expected ${input.expectedCommit}. Nothing was published and the session is unchanged; retry the publish.`,
			input.cause === undefined ? undefined : { cause: input.cause },
		)
		this.name = 'RemoteRefNotConfirmedError'
		this.ref = input.ref
		this.expectedCommit = input.expectedCommit
		this.observedCommit = input.observedCommit
	}
}

export function isRemoteRefNotConfirmedError(
	error: unknown,
): error is RemoteRefNotConfirmedError {
	return error instanceof RemoteRefNotConfirmedError
}
