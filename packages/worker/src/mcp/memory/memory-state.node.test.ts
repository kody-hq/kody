import { expect, test } from 'vitest'
import { memoryState } from './memory-state.ts'

test('memory insert and update accept every status replacement', () => {
	expect(memoryState.parse('active')).toBe('active')
	expect(memoryState.parse('deleted')).toBe('deleted')
	expect(memoryState.parse('archived')).toBe('archived')
	expect(memoryState.is('missing')).toBe(false)
	expect(() => memoryState.parse('missing')).toThrow('mcp_memories.status')
})
