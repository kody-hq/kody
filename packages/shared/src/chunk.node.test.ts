import { expect, test } from 'vitest'
import { chunkArray } from './chunk.ts'

test('splits into chunks of at most the requested size', () => {
	expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
	expect(chunkArray([1, 2], 2)).toEqual([[1, 2]])
	expect(chunkArray([], 3)).toEqual([])
})
