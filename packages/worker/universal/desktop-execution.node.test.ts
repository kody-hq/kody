import { expect, test } from 'vitest'
import { desktopExecutionChain } from './desktop-execution.ts'
import type { ExecutionChain } from './execution-contexts.ts'
function chain(ids: Array<string>, cloud = true): ExecutionChain {
	return {
		entries: [
			...ids.map((id) => ({ kind: 'context' as const, id, usable: true })),
			...(cloud ? [{ kind: 'cloud' as const }] : []),
		],
		strict: !cloud,
		updatedAt: null,
		updatedBy: null,
	}
}
test('desktop registration goes first, without duplicating entries or changing fallback policy', () => {
	expect(desktopExecutionChain(chain(['a', 'new', 'b']), 'new')).toEqual({
		entries: [
			{ kind: 'context', id: 'new' },
			{ kind: 'context', id: 'a' },
			{ kind: 'context', id: 'b' },
			{ kind: 'cloud' },
		],
		strict: false,
	})
	expect(desktopExecutionChain(chain(['a'], false), 'new')).toEqual({
		entries: [
			{ kind: 'context', id: 'new' },
			{ kind: 'context', id: 'a' },
		],
		strict: true,
	})
})
test('a full chain requires an explicit replacement and preserves the other entries', () => {
	const full = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
	expect(() => desktopExecutionChain(chain(full), 'new')).toThrow('full')
	expect(desktopExecutionChain(chain(full), 'new', 'b').entries).toEqual([
		{ kind: 'context', id: 'new' },
		...full.filter((id) => id !== 'b').map((id) => ({ kind: 'context', id })),
		{ kind: 'cloud' },
	])
	expect(() => desktopExecutionChain(chain(['a']), 'new', 'missing')).toThrow(
		'changed',
	)
})
