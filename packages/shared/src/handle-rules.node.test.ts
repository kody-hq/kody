import { expect, test } from 'vitest'
import {
	diagnoseHandleFormat,
	getHandleFormatError,
	getHandleFormatProblem,
	isValidHandle,
	suggestHandle,
} from './handle-rules.ts'

test('suggestHandle strips diacritics, spaces, and punctuation', () => {
	expect(suggestHandle('Ján Kováč')).toBe('jan-kovac')
	expect(suggestHandle('Jozef Novak')).toBe('jozef-novak')
	expect(suggestHandle('joe_cool')).toBe('joe-cool')
	expect(suggestHandle('john.doe')).toBe('john-doe')
	expect(suggestHandle('  Trailing Space  ')).toBe('trailing-space')
	expect(suggestHandle('ab')).toBeNull()
	expect(suggestHandle('---')).toBeNull()
	expect(suggestHandle('Pinned 1234567890')).toBe('pinned-1234567890')
})

test('diagnoseHandleFormat covers spaces, diacritics, length, and edge hyphens', () => {
	expect(diagnoseHandleFormat('')).toBe('required')
	expect(diagnoseHandleFormat('   ')).toBe('required')
	expect(diagnoseHandleFormat('joe cool')).toBe('spaces')
	expect(diagnoseHandleFormat('Ján')).toBe('diacritics')
	expect(diagnoseHandleFormat('joe_cool')).toBe('underscores')
	expect(diagnoseHandleFormat('john.doe')).toBe('dots')
	expect(diagnoseHandleFormat('ab')).toBe('too-short')
	expect(diagnoseHandleFormat('a'.repeat(33))).toBe('too-long')
	expect(diagnoseHandleFormat('-joe')).toBe('leading-hyphen')
	expect(diagnoseHandleFormat('joe-')).toBe('trailing-hyphen')
	expect(diagnoseHandleFormat('joe!')).toBe('other-characters')
	expect(diagnoseHandleFormat('joe--cool')).toBe('consecutive-hyphens')
	expect(diagnoseHandleFormat('some-user')).toBeNull()
	// Trailing whitespace alone does not fail once trimmed.
	expect(diagnoseHandleFormat('kent ')).toBeNull()
	expect(diagnoseHandleFormat('  kent')).toBeNull()
})

test('isValidHandle matches the DNS-safe username pattern', () => {
	expect(isValidHandle('kent')).toBe(true)
	expect(isValidHandle('Kent')).toBe(true)
	expect(isValidHandle('kent ')).toBe(true)
	expect(isValidHandle('kent_cdodds')).toBe(false)
	expect(isValidHandle('ján')).toBe(false)
	// `--` separates the package leaf from the handle in a per-app host label.
	expect(isValidHandle('joe-cool-guy')).toBe(true)
	expect(isValidHandle('joe--cool')).toBe(false)
	expect(isValidHandle('notes--kent')).toBe(false)
	expect(getHandleFormatError('joe--cool')).toBe(
		"Username can't include two hyphens in a row.",
	)
})

test('getHandleFormatProblem keeps the unverified suggestion out of the message', () => {
	expect(getHandleFormatProblem('jsdklfjsdlsks;j')).toEqual({
		message: 'Username can only use a–z letters, numbers, and hyphens.',
		suggestion: 'jsdklfjsdlsks-j',
	})
	expect(getHandleFormatProblem('Acme Co', { label: 'Handle' })).toEqual({
		message: "Handle can't include spaces.",
		suggestion: 'acme-co',
	})
	expect(getHandleFormatProblem('')).toEqual({
		message: 'Username is required.',
		suggestion: null,
	})
	expect(getHandleFormatProblem('ab')?.suggestion).toBeNull()
	expect(getHandleFormatProblem('kent')).toBeNull()
})
