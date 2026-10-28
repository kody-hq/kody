import { expect, test } from 'vitest'
import {
	createRepoChecksFailedError,
	isRepoChecksFailedError,
	RepoChecksFailedError,
	repoChecksFailedCallerMessage,
	repoChecksFailedErrorName,
} from './repo-checks-failed-error.ts'

test('createRepoChecksFailedError joins failed check messages', () => {
	const error = createRepoChecksFailedError([
		{
			kind: 'typecheck',
			ok: false,
			message: 'src/receive.js(1,1): type error',
		},
		{ kind: 'docs', ok: true, message: 'ok' },
		{ kind: 'bundle', ok: false, message: 'bundle boom' },
	])
	expect(error).toBeInstanceOf(RepoChecksFailedError)
	expect(error.name).toBe(repoChecksFailedErrorName)
	expect(error.message).toBe('src/receive.js(1,1): type error\nbundle boom')
})

test('isRepoChecksFailedError matches live class, name-only RPC shape, and JSRPC prefix', () => {
	const nameOnly = new Error('src/receive.js type mismatch')
	nameOnly.name = repoChecksFailedErrorName
	expect(isRepoChecksFailedError(nameOnly)).toBe(true)

	expect(
		isRepoChecksFailedError(
			new Error(`${repoChecksFailedErrorName}: src/receive.js type mismatch`),
		),
	).toBe(true)

	expect(
		isRepoChecksFailedError(new Error('src/receive.js type mismatch')),
	).toBe(false)
	expect(isRepoChecksFailedError(new Error('platform boom'))).toBe(false)
	expect(isRepoChecksFailedError(null)).toBe(false)
	expect(isRepoChecksFailedError('RepoChecksFailedError')).toBe(false)
})

test('repoChecksFailedCallerMessage strips a JSRPC name prefix', () => {
	expect(
		repoChecksFailedCallerMessage(
			new Error(`${repoChecksFailedErrorName}: src/receive.js type mismatch`),
		),
	).toBe('src/receive.js type mismatch')
	expect(
		repoChecksFailedCallerMessage(
			new RepoChecksFailedError('src/receive.js type mismatch'),
		),
	).toBe('src/receive.js type mismatch')
})
