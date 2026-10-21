import { expect, test } from 'vitest'
import {
	normalizePlatformFeedbackResolutionNote,
	normalizePlatformFeedbackResolutionPrUrls,
	parsePlatformFeedbackResolutionPrUrls,
	serializePlatformFeedbackResolutionPrUrls,
} from './resolution.ts'

test('normalizePlatformFeedbackResolutionNote trims and clears empty values', () => {
	expect(normalizePlatformFeedbackResolutionNote(undefined)).toBeUndefined()
	expect(normalizePlatformFeedbackResolutionNote('  shipped  ')).toBe('shipped')
	expect(normalizePlatformFeedbackResolutionNote('   ')).toBeNull()
	expect(() =>
		normalizePlatformFeedbackResolutionNote('x'.repeat(2_001)),
	).toThrow(/at most 2000/)
})

test('normalizePlatformFeedbackResolutionPrUrls enforces https, count, length, and dedupes', () => {
	expect(normalizePlatformFeedbackResolutionPrUrls(undefined)).toBeUndefined()
	expect(normalizePlatformFeedbackResolutionPrUrls([])).toBeNull()
	expect(
		normalizePlatformFeedbackResolutionPrUrls([
			'  https://example.com/a  ',
			'https://example.com/a',
			'https://example.com/b',
		]),
	).toEqual(['https://example.com/a', 'https://example.com/b'])
	expect(() =>
		normalizePlatformFeedbackResolutionPrUrls(['ftp://example.com/a']),
	).toThrow(/https only/)
	expect(() => normalizePlatformFeedbackResolutionPrUrls([''])).toThrow(
		/must not be empty/,
	)
})

test('serialize and parse round-trip resolution PR URLs', () => {
	expect(serializePlatformFeedbackResolutionPrUrls(null)).toBeNull()
	expect(serializePlatformFeedbackResolutionPrUrls([])).toBeNull()
	const json = serializePlatformFeedbackResolutionPrUrls([
		'https://example.com/1',
	])
	expect(parsePlatformFeedbackResolutionPrUrls(json)).toEqual([
		'https://example.com/1',
	])
	expect(parsePlatformFeedbackResolutionPrUrls(null)).toEqual([])
	expect(parsePlatformFeedbackResolutionPrUrls('{')).toEqual([])
	expect(parsePlatformFeedbackResolutionPrUrls('{"a":1}')).toEqual([])
})
