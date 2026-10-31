import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { listArtifactServerRefs } from './artifacts.ts'
import { RemoteRefNotConfirmedError } from './remote-ref-not-confirmed-error.ts'

export { RemoteRefNotConfirmedError }

export function toFullBranchRef(ref: string) {
	return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`
}

const defaultConfirmDelaysMs = [250, 1_000]

/**
 * Read the remote ref advertisement after a push and require `ref` to point
 * at `commit`. A push that reports success is not enough: publish moves
 * `published_commit` and releases the session workspace (the only other copy
 * of the commit), so the new tip must be durably reachable from a ref first.
 * Retries briefly to absorb read-after-write lag.
 */
export async function confirmRemoteRefAtCommit(input: {
	remote: string
	token: string
	ref: string
	commit: string
	delaysMs?: ReadonlyArray<number>
	sleep?: (ms: number) => Promise<void>
	listRefs?: typeof listArtifactServerRefs
}): Promise<void> {
	const fullRef = toFullBranchRef(input.ref)
	const listRefs = input.listRefs ?? listArtifactServerRefs
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const delays = input.delaysMs ?? defaultConfirmDelaysMs
	let observed: string | null = null
	let lastError: unknown
	for (let attempt = 0; attempt <= delays.length; attempt += 1) {
		if (attempt > 0) await sleep(delays[attempt - 1]!)
		try {
			const refs = await listRefs({
				remote: input.remote,
				token: input.token,
				prefix: fullRef,
			})
			observed = refs.find((entry) => entry.ref === fullRef)?.oid ?? null
			lastError = undefined
			if (observed === input.commit) return
		} catch (error) {
			lastError = error
		}
	}
	if (lastError !== undefined && observed === null) {
		throw new RemoteRefNotConfirmedError({
			ref: fullRef,
			expectedCommit: input.commit,
			observedCommit: null,
			cause: new Error(
				`Listing remote refs failed: ${getErrorMessage(lastError)}`,
				{ cause: lastError },
			),
		})
	}
	throw new RemoteRefNotConfirmedError({
		ref: fullRef,
		expectedCommit: input.commit,
		observedCommit: observed,
	})
}
