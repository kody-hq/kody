import {
	getErrorCauseChain,
	getErrorMessage,
} from '@kody-internal/shared/error-message.ts'
import { isArtifactsGitMissingObjectMessage } from './artifacts-git-retry.ts'

/**
 * User-facing failure when approve-publish (or another external publish)
 * names a commit the cloned source does not contain. Distinct from a
 * restorable-backup / source-recovery failure, which is about the existing
 * published commit.
 */
export function buildUnknownRequestedCommitMessage(commit: string) {
	return `The requested commit "${commit.trim()}" was not found in the package source.`
}

export function isUnknownRequestedCommitMessage(message: string) {
	return (
		message.startsWith('The requested commit "') &&
		message.endsWith('" was not found in the package source.')
	)
}

function errorCode(error: Error) {
	if ('code' in error && typeof error.code === 'string') return error.code
	return null
}

/**
 * isomorphic-git `git.checkout` accepts a 40-hex oid without checking the
 * object, then throws `CommitNotFetchedError` when that object is absent.
 * Anything else is resolved as a ref and, on a miss, retried as
 * `origin/<ref>` (`Could not find origin/<ref>`).
 */
export function isUnknownRequestedCommitCheckoutError(error: unknown) {
	const message = getErrorMessage(error)
	// A failed clone can mention a missing ref in its cause. That is a clone
	// failure, not an unknown requested commit.
	if (message.startsWith('Artifacts git clone failed')) return false
	if (message.startsWith('Failed to resolve cloned HEAD')) return false
	for (const entry of getErrorCauseChain(error)) {
		if (!(entry instanceof Error)) continue
		const code = errorCode(entry)
		if (
			code === 'CommitNotFetchedError' ||
			entry.name === 'CommitNotFetchedError'
		) {
			return true
		}
		if (/is not available locally/i.test(entry.message)) return true
		if (code === 'NotFoundError' || entry.name === 'NotFoundError') return true
		if (isArtifactsGitMissingObjectMessage(entry.message)) return true
	}
	return false
}

export function unknownRequestedCommitError(error: unknown, commit: string) {
	const message = getErrorMessage(error)
	if (isUnknownRequestedCommitMessage(message)) {
		return error instanceof Error ? error : new Error(message)
	}
	if (!isUnknownRequestedCommitCheckoutError(error)) return null
	return new Error(buildUnknownRequestedCommitMessage(commit), { cause: error })
}

function isPublishCloneStorageFailureMessage(message: string) {
	return (
		message.includes('SQLITE_TOOBIG') || /string or blob too big/i.test(message)
	)
}

function externalPublishCloneFailureReason(message: string) {
	if (
		message.startsWith('Artifacts git clone failed') ||
		message.startsWith('Failed to resolve cloned HEAD') ||
		message.startsWith('commit checkout failed:') ||
		message.startsWith('source clone failed:')
	) {
		return message
	}
	return `source clone failed: ${message}`
}

export type ExternalPublishCloneFailure =
	| { kind: 'rethrow' }
	| { kind: 'unknown_commit'; error: Error }
	| { kind: 'storage' }
	| { kind: 'source_recovery'; reason: string }

/**
 * Split a `publishFromExternalRef` clone/checkout failure before any
 * source-recovery wrap. An unknown requested commit, a clone failure, and a
 * storage failure stay different kinds.
 */
export function classifyExternalPublishCloneError(
	error: unknown,
	commit: string,
): ExternalPublishCloneFailure {
	const message = getErrorMessage(error)
	if (message.includes('Artifacts HEAD changed from')) {
		return { kind: 'rethrow' }
	}
	const unknownCommit = unknownRequestedCommitError(error, commit)
	if (unknownCommit) return { kind: 'unknown_commit', error: unknownCommit }
	if (isPublishCloneStorageFailureMessage(message)) return { kind: 'storage' }
	return {
		kind: 'source_recovery',
		reason: externalPublishCloneFailureReason(message),
	}
}
