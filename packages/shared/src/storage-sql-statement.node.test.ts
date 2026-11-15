import { expect, test } from 'vitest'
import { normalizeSqlParams } from './storage-sql-statement.ts'

test('normalizeSqlParams binds each array element to one placeholder', () => {
	expect(normalizeSqlParams([])).toEqual([])
	expect(normalizeSqlParams(['k'])).toEqual(['k'])
	expect(normalizeSqlParams(['k', 2, true, false, null])).toEqual([
		'k',
		2,
		1,
		0,
		null,
	])
})

test('normalizeSqlParams binds nothing for a missing or non-array params', () => {
	expect(normalizeSqlParams(undefined)).toEqual([])
	expect(normalizeSqlParams(null)).toEqual([])
	expect(normalizeSqlParams('k')).toEqual([])
})

test('normalizeSqlParams rejects array, object, and undefined elements', () => {
	const message =
		'storage.sql params only support strings, numbers, booleans, and null.'
	expect(() => normalizeSqlParams([['k']])).toThrow(message)
	expect(() => normalizeSqlParams([{ k: 1 }])).toThrow(message)
	expect(() => normalizeSqlParams([undefined])).toThrow(message)
})
