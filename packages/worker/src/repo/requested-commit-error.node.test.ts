import { expect, test } from 'vitest'
import { type EntitySourceRow } from './types.ts'
import { buildSourceRecoveryProblemMessage } from './source-safety-policy.ts'
import {
	buildUnknownRequestedCommitMessage,
	classifyExternalPublishCloneError,
	unknownRequestedCommitError,
} from './requested-commit-error.ts'

const publishedSource = {
	id: 'source-1',
	published_commit: '0123456789abcdef0123456789abcdef01234567',
} as EntitySourceRow

test('an unknown full SHA is not classified as a backup or clone failure', () => {
	const commit = 'fedcba9876543210fedcba9876543210fedcba98'
	const classified = classifyExternalPublishCloneError(
		Object.assign(
			new Error(
				`Failed to checkout "${commit}" because commit ${commit} is not available locally. Do a git fetch to make the branch available locally.`,
			),
			{ name: 'CommitNotFetchedError', code: 'CommitNotFetchedError' },
		),
		commit,
	)
	expect(classified.kind).toBe('unknown_commit')
	if (classified.kind !== 'unknown_commit') return
	expect(classified.error.message).toBe(
		buildUnknownRequestedCommitMessage(commit),
	)
	expect(classified.error.message).not.toContain('restorable backup')
	expect(classified.error.message).not.toContain('source clone failed')
})

test('clone failures and storage failures stay different kinds', () => {
	const commit = '0123456789abcdef0123456789abcdef01234567'
	const cloneFailure = classifyExternalPublishCloneError(
		new Error(
			'Artifacts git clone failed for https://example.test/repo.git: HTTP Error: 500 Internal Server Error',
		),
		commit,
	)
	expect(cloneFailure.kind).toBe('source_recovery')
	if (cloneFailure.kind !== 'source_recovery') return
	expect(cloneFailure.reason).toContain('Artifacts git clone failed')
	expect(cloneFailure.reason).not.toContain('SQLITE_TOOBIG')
	const wrapped = buildSourceRecoveryProblemMessage({
		source: publishedSource,
		operation: 'packagePublishExternalPush',
		reason: cloneFailure.reason,
	})
	expect(wrapped).toContain('restorable backup snapshot')
	expect(wrapped).toContain('Artifacts git clone failed')
	expect(wrapped).not.toContain('was not found in the package source')

	const cloneMiss = new Error(
		'Artifacts git clone failed for https://example.test/repo.git: Could not find refs/heads/main.',
	)
	const recovery = new Error(
		buildSourceRecoveryProblemMessage({
			source: publishedSource,
			operation: 'packagePublishExternalPush',
			reason: cloneMiss.message,
		}),
		{ cause: cloneMiss },
	)
	expect(unknownRequestedCommitError(recovery, commit)).toBeNull()
	expect(classifyExternalPublishCloneError(cloneMiss, commit).kind).toBe(
		'source_recovery',
	)

	const storageFailure = classifyExternalPublishCloneError(
		new Error('string or blob too big: SQLITE_TOOBIG'),
		commit,
	)
	expect(storageFailure).toEqual({ kind: 'storage' })
})
