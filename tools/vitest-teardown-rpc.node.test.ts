import { expect, test } from 'vitest'
import {
	ignoreVitestTeardownRpcError,
	isVitestTeardownRpcError,
} from './vitest-teardown-rpc.ts'

test('a teardown rpc error with a pending resolve is ignored', () => {
	const error = {
		name: 'EnvironmentTeardownError',
		message: '[vitest-worker]: Closing rpc while "resolve" was pending',
	}
	expect(isVitestTeardownRpcError(error)).toBe(true)
	expect(ignoreVitestTeardownRpcError(error)).toBe(false)
})

test('other unhandled errors still fail the run', () => {
	expect(
		ignoreVitestTeardownRpcError({ name: 'Error', message: 'boom' }),
	).toBeUndefined()
	expect(
		ignoreVitestTeardownRpcError({
			name: 'EnvironmentTeardownError',
			message: 'Worker exited unexpectedly',
		}),
	).toBeUndefined()
	expect(
		ignoreVitestTeardownRpcError({
			name: 'TypeError',
			message: 'Closing rpc while "resolve" was pending',
		}),
	).toBeUndefined()
})
