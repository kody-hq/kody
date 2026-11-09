import { expect, test } from 'vitest'
import { memoryState } from './memory-state.ts'

test('memory insert and update accept every status replacement', () => {
	const statuses = ['active', 'deleted', 'archived'] as const
	expect(memoryState.initial).toEqual([...statuses])
	for (const from of statuses) {
		expect(memoryState.isTerminal(from)).toBe(false)
		for (const to of statuses) {
			expect(memoryState.can(from, to)).toBe(true)
		}
	}
})
