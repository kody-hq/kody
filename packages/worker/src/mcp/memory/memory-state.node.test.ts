import { expect, test } from 'vitest'
import { memoryState } from './memory-state.ts'

test('memory insert and update accept every status replacement', () => {
	const statuses = ['active', 'deleted', 'archived'] as const
	expect(memoryState.values).toEqual([...statuses])
	for (const value of statuses) expect(memoryState.parse(value)).toBe(value)
	expect(memoryState.sql(statuses)).toBe("('active', 'deleted', 'archived')")
	expect(memoryState.is('missing')).toBe(false)
	expect(() => memoryState.parse('missing')).toThrow('mcp_memories.status')
	expect(memoryState).not.toHaveProperty('transitions')
})
