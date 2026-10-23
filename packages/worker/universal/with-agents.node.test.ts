import { expect, test } from 'vitest'
import { findWithAgentByPathname } from './with-agents.ts'

test('pathname lookup only accepts /with/:agent for catalog agents', () => {
	expect(findWithAgentByPathname('/with/cursor')?.name).toBe('Cursor')
	expect(findWithAgentByPathname('/with/cursor/')?.name).toBe('Cursor')
	expect(findWithAgentByPathname('/with/unknown')).toBeNull()
	expect(findWithAgentByPathname('/with/cursor/extra')).toBeNull()
})
