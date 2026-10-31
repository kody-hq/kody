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
			`The source repo did not confirm the push: ${input.ref} is at ${input.observedCommit ?? 'no commit'}, expected ${input.expectedCommit}. ${input.observedCommit === null ? 'published_commit did not move, but the publish outcome is unknown: the push may have landed. Check the source ref before retrying.' : 'Nothing was published and the session is unchanged; retry the publish.'}`,
			input.cause === undefined ? undefined : { cause: input.cause },
		)
		this.name = 'RemoteRefNotConfirmedError'
		this.ref = input.ref
		this.expectedCommit = input.expectedCommit
		this.observedCommit = input.observedCommit
	}
}

const notConfirmedMessagePattern =
	/did not confirm the push: (\S+) is at (no commit|\S+), expected ([0-9a-f]+)\./

/**
 * Durable Object RPC rebuilds thrown errors as plain `Error`s that keep
 * `name` and `message`, so match on those and read the fields back from the
 * message when the class did not survive.
 */
export function readRemoteRefNotConfirmedError(error: unknown): {
	message: string
	ref: string
	expectedCommit: string
	observedCommit: string | null
} | null {
	if (error instanceof RemoteRefNotConfirmedError) {
		return {
			message: error.message,
			ref: error.ref,
			expectedCommit: error.expectedCommit,
			observedCommit: error.observedCommit,
		}
	}
	if (
		!(error instanceof Error) ||
		error.name !== 'RemoteRefNotConfirmedError'
	) {
		return null
	}
	const match = notConfirmedMessagePattern.exec(error.message)
	if (!match) return null
	return {
		message: error.message,
		ref: match[1]!,
		expectedCommit: match[3]!,
		observedCommit: match[2] === 'no commit' ? null : match[2]!,
	}
}

export function isRemoteRefNotConfirmedError(error: unknown) {
	return readRemoteRefNotConfirmedError(error) !== null
}
