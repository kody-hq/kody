import { expect, test } from 'vitest'
import {
	ExecutionContextsUnavailableError,
	parseChain,
	readExecutionContextFailure,
} from './execution-contexts.ts'

test('parseChain keeps cloud last and marks stored unusable entries', () => {
	const chain = parseChain({
		entries: [
			{ kind: 'cloud' },
			{ kind: 'context', id: 'ec_a', usable: false, unusableReason: 'revoked' },
			{ kind: 'context', id: 'ec_b', usable: true },
		],
		updatedAt: '2026-01-02T03:04:05.000Z',
	})
	expect(chain.entries).toEqual([
		{ kind: 'context', id: 'ec_a', usable: false, unusableReason: 'revoked' },
		{ kind: 'context', id: 'ec_b', usable: true },
		{ kind: 'cloud' },
	])
	expect(chain.updatedAt).toBe('2026-01-02T03:04:05.000Z')
})

test('parseChain defaults to cloud only when the chain is missing', () => {
	expect(parseChain(undefined).entries).toEqual([{ kind: 'cloud' }])
})

test('readExecutionContextFailure maps chain_changed with the current chain', () => {
	const failure = readExecutionContextFailure({
		status: 409,
		error: 'chain_changed',
		message: 'Chain changed.',
		details: {
			current: { entries: [{ kind: 'context', id: 'ec_a', usable: true }] },
		},
	})
	expect(failure).toMatchObject({
		ok: false,
		error: 'chain_changed',
		status: 409,
		current: {
			entries: [{ kind: 'context', id: 'ec_a', usable: true }],
		},
	})
})

test('readExecutionContextFailure keeps contextId for context_not_usable', () => {
	expect(
		readExecutionContextFailure({
			error: 'context_not_usable',
			message: 'Not usable.',
			contextId: 'ec_b',
		}),
	).toEqual({
		ok: false,
		error: 'context_not_usable',
		message: 'Not usable.',
		contextId: 'ec_b',
	})
})

test('readExecutionContextFailure reads nested error codes', () => {
	expect(
		readExecutionContextFailure({
			message: 'Your login is too old.',
			body: { error: { code: 'credential_scope' } },
		}),
	).toMatchObject({ ok: false, error: 'credential_scope' })
})

test('an unavailable registry reads as feature_disabled, not denied', () => {
	expect(
		readExecutionContextFailure(new ExecutionContextsUnavailableError()),
	).toMatchObject({ ok: false, error: 'feature_disabled' })
	expect(readExecutionContextFailure(new Error('plain'))).toBeNull()
})
