import { expect, test } from 'vitest'
import {
	createRepoChecksError,
	isRepoChecksFailedError,
	RepoChecksFailedError,
	repoChecksFailedCallerMessage,
	repoChecksFailedErrorName,
	RepoChecksPlatformError,
	repoChecksPlatformErrorName,
} from './repo-checks-failed-error.ts'

test('createRepoChecksError joins author check failures into RepoChecksFailedError', () => {
	const error = createRepoChecksError([
		{
			kind: 'typecheck',
			ok: false,
			message: 'src/receive.js(1,1): type error',
		},
		{ kind: 'docs', ok: true, message: 'ok' },
		{
			kind: 'bundle',
			ok: false,
			message: 'bundle boom',
			failureOrigin: 'author',
		},
	])
	expect(error).toBeInstanceOf(RepoChecksFailedError)
	expect(error.name).toBe(repoChecksFailedErrorName)
	expect(error.message).toBe('src/receive.js(1,1): type error\nbundle boom')
})

test('createRepoChecksError throws RepoChecksPlatformError when any failure is Kody infrastructure', () => {
	const error = createRepoChecksError([
		{ kind: 'typecheck', ok: false, message: 'src/a.ts(1,1): type error' },
		{
			kind: 'dependencies',
			ok: false,
			failureOrigin: 'platform',
			message: 'Could not load the saved package manifest for @scope/b.',
		},
	])
	expect(error).toBeInstanceOf(RepoChecksPlatformError)
	expect(error.name).toBe(repoChecksPlatformErrorName)
	expect(error.message).toContain('Kody platform failure')
	expect(error.message).toContain('not a problem with your package')
	expect(error.message).toContain('@scope/b')
	expect(error.message).not.toContain('type error')
	expect(isRepoChecksFailedError(error)).toBe(false)
	expect(
		isRepoChecksFailedError(
			new Error(`${repoChecksPlatformErrorName}: ${error.message}`),
		),
	).toBe(false)
})

test('isRepoChecksFailedError matches live class, name-only RPC shape, and JSRPC prefix', () => {
	expect(
		isRepoChecksFailedError(
			new RepoChecksFailedError('src/receive.js type mismatch'),
		),
	).toBe(true)

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
