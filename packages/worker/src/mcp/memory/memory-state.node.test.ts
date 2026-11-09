import { expect, test } from 'vitest'
import { memoryState } from './memory-state.ts'

test('mcp_memories.status preserves the accepted lifecycle graph', () => {
	expect(memoryState.initial).toEqual(['active', 'deleted', 'archived'])
	expect(memoryState.transitions).toEqual({
		active: ['active', 'deleted', 'archived'],
		deleted: ['active', 'deleted', 'archived'],
		archived: ['active', 'deleted', 'archived'],
	})
	expect(memoryState.terminal).toEqual([])
})
