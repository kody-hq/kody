import { expect, test } from 'vitest'
import {
	errorCauseChainIncludes,
	formatErrorCauseChain,
	getErrorMessage,
} from './error-message.ts'

test('getErrorMessage reads Error messages and stringifies other values', () => {
	expect(getErrorMessage(new Error('boom'))).toBe('boom')
	expect(getErrorMessage('plain')).toBe('plain')
	expect(getErrorMessage(42)).toBe('42')
	expect(getErrorMessage(null)).toBe('null')
	expect(
		getErrorMessage({
			name: 'ArtifactsError',
			code: 'INTERNAL_ERROR',
			message: 'An unexpected internal error occurred.',
		}),
	).toBe('An unexpected internal error occurred.')
	expect(
		getErrorMessage({ name: 'ArtifactsError', code: 'INTERNAL_ERROR' }),
	).toBe('[object Object]')
})

test('cause chains are traversed without looping on cycles', () => {
	const root = new Error('root cause')
	const wrapped = new Error('wrapper', { cause: root })
	expect(formatErrorCauseChain(wrapped)).toBe('wrapper Caused by: root cause')
	expect(
		errorCauseChainIncludes(wrapped, (message) => message === 'root cause'),
	).toBe(true)

	const cyclic = new Error('cyclic')
	cyclic.cause = cyclic
	expect(formatErrorCauseChain(cyclic)).toBe('cyclic')
})

test('getErrorMessage never returns a blank message', () => {
	const esbuildShaped = Object.assign(new Error(''), {
		errors: [{ text: 'Unexpected "\\x00"' }, { text: '' }],
	})
	expect(getErrorMessage(esbuildShaped)).toBe('Unexpected "\\x00"')
	expect(
		getErrorMessage(new Error('  ', { cause: new Error('inner failure') })),
	).toBe('inner failure')
	expect(getErrorMessage(new TypeError(''))).toBe(
		'TypeError (no error message was provided)',
	)
	expect(getErrorMessage('  ')).toBe('Error (no error message was provided)')
	expect(getErrorMessage({ message: '' })).toBe(
		'Error (no error message was provided)',
	)
	const cyclic = new Error('')
	cyclic.cause = cyclic
	expect(getErrorMessage(cyclic)).toBe('Error (no error message was provided)')
	expect(formatErrorCauseChain(new Error('', { cause: new Error('x') }))).toBe(
		'x',
	)
})

test('getErrorMessage escapes NUL characters that truncate transports', () => {
	expect(getErrorMessage(new Error('Unexpected "\0" here'))).toBe(
		'Unexpected "\\0" here',
	)
})
