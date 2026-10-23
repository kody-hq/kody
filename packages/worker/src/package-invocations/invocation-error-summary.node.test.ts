import { expect, test } from 'vitest'
import {
	invocationErrorSummaryMaxLength,
	sanitizeInvocationErrorMessage,
	summarizeInvocationError,
} from './invocation-error-summary.ts'

test('keeps ordinary export error text, including TypeScript diagnostics', () => {
	const message =
		"src/index.ts(1,1): error TS2345: Argument of type '(params: { name: string; }) => Promise<string>' is not assignable to parameter of type '(params?: Record<string, unknown>) => unknown'."
	expect(sanitizeInvocationErrorMessage(message)).toBe(message)
	const typed = "Type '{ secret: string; }' is missing the following properties"
	expect(sanitizeInvocationErrorMessage(typed)).toBe(typed)
})

test('redacts credential-shaped values before copying an error', () => {
	const fakeKodyToken = ['kody', 'at', 'a'.repeat(20), 'k'.repeat(43)].join('_')
	const fakeGithubToken = `ghp_${'a1'.repeat(18)}`
	const fakeStripeKey = ['sk', 'live', 'Z'.repeat(24)].join('_')
	const sanitized = sanitizeInvocationErrorMessage(
		[
			`token ${fakeKodyToken} rejected`,
			`GitHub said no to ${fakeGithubToken}`,
			`Stripe key ${fakeStripeKey}`,
			'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
			'fetch https://user:hunter2hunter2@example.com/path?api_key=abc123secret&x=1',
			'config {"password": "correct-horse-battery"}',
		].join('\n'),
	)
	expect(sanitized).not.toContain(fakeKodyToken)
	expect(sanitized).not.toContain(fakeGithubToken)
	expect(sanitized).not.toContain(fakeStripeKey)
	expect(sanitized).not.toContain('abcdefghijklmnopqrstuvwxyz')
	expect(sanitized).not.toContain('hunter2hunter2')
	expect(sanitized).not.toContain('abc123secret')
	expect(sanitized).not.toContain('correct-horse-battery')
	expect(sanitized).toContain('Bearer [redacted]')
	expect(sanitized).toContain(
		'https://[redacted]@example.com/path?api_key=[redacted]&x=1',
	)
})

test('bounds long messages and drops control characters', () => {
	const sanitized = sanitizeInvocationErrorMessage(
		`boom\u0000\u0007 ${'x'.repeat(invocationErrorSummaryMaxLength * 2)}`,
	)
	expect(sanitized.length).toBe(invocationErrorSummaryMaxLength)
	expect(sanitized.startsWith('boom x')).toBe(true)
	expect(sanitized.endsWith('…')).toBe(true)
})

test('summarizes errors, strings, and message-bearing objects', () => {
	expect(summarizeInvocationError(new Error('bad input'))).toBe('bad input')
	expect(summarizeInvocationError('plain')).toBe('plain')
	expect(summarizeInvocationError({ message: 'from object' })).toBe(
		'from object',
	)
	expect(summarizeInvocationError(null)).toBeNull()
	expect(summarizeInvocationError({ code: 1 })).toBeNull()
	expect(summarizeInvocationError(new Error('   '))).toBeNull()
})
