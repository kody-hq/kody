import { expect, test } from 'vitest'
import { mediaType } from './media-type.ts'

test('mediaType reads only the type/subtype, never parameter values', () => {
	expect(mediaType('Application/JSON; charset=utf-8')).toBe('application/json')
	expect(mediaType('text/plain; note=application/json')).toBe('text/plain')
	expect(mediaType('text/plain;application/x-www-form-urlencoded')).toBe(
		'text/plain',
	)
	expect(mediaType(null)).toBe('')
})
