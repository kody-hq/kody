import { expect, test } from 'vitest'
import { startRouteTreeRegisterFooter } from './generate-start-route-tree.ts'
import { startRouteTreeDrift } from './check-start-route-tree.ts'

test('the Start Register footer names getRouter and startInstance', () => {
	const [block] = startRouteTreeRegisterFooter()
	expect(block).toContain("declare module '@tanstack/react-start'")
	expect(block).toContain('interface Register')
	expect(block).toContain("from './router.tsx'")
	expect(block).toContain("from './start.ts'")
	expect(block).toContain('startInstance.getOptions')
})

test('start route tree drift samples the first mismatched lines', () => {
	expect(startRouteTreeDrift('a\nb\n', 'a\nb\n')).toBeNull()
	expect(startRouteTreeDrift('a\nb\n', 'a\nc\n')).toEqual(['line 2\n- b\n+ c'])
})
