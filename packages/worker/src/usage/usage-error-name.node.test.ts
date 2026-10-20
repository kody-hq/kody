import { expect, test } from 'vitest'
import {
	sanitizeUsageErrorName,
	usageErrorNameFromUnknown,
	usageErrorNameMaxLength,
} from './usage-error-name.ts'

test('sanitizeUsageErrorName keeps short codes and drops messages', () => {
	expect(sanitizeUsageErrorName('credential_need_undeclared')).toBe(
		'credential_need_undeclared',
	)
	expect(sanitizeUsageErrorName('TimeoutError')).toBe('TimeoutError')
	expect(sanitizeUsageErrorName(' bad name ')).toBe('')
	expect(sanitizeUsageErrorName('a'.repeat(usageErrorNameMaxLength + 5))).toBe(
		'a'.repeat(usageErrorNameMaxLength),
	)
	expect(sanitizeUsageErrorName(null)).toBe('')
})

test('usageErrorNameFromUnknown prefers code, bracket prefix, then name', () => {
	expect(
		usageErrorNameFromUnknown({
			code: 'credential_need_undeclared',
			name: 'CredentialNeedUndeclaredError',
			message: '[credential_need_undeclared] Package refused',
		}),
	).toBe('credential_need_undeclared')
	expect(
		usageErrorNameFromUnknown({
			name: 'Error',
			message: '[credential_need_undeclared] Package refused',
		}),
	).toBe('credential_need_undeclared')
	expect(
		usageErrorNameFromUnknown(
			'[credential_need_undeclared] Package refused a secret',
		),
	).toBe('credential_need_undeclared')
	expect(
		usageErrorNameFromUnknown({
			body: { code: 'credential_need_undeclared' },
			message: 'refused',
		}),
	).toBe('credential_need_undeclared')
	expect(usageErrorNameFromUnknown(new TypeError('boom'))).toBe('TypeError')
	expect(usageErrorNameFromUnknown(new Error('boom'))).toBe('Error')
	expect(usageErrorNameFromUnknown(null)).toBe('')
})
