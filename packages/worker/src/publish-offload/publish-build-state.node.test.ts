import { expect, test } from 'vitest'
import { publishBuildState } from './publish-build-state.ts'

test('publish builds seal before commit, and committed builds may re-finalize or reject', () => {
	expect(publishBuildState.can('uploading', 'sealed')).toBe(true)
	expect(publishBuildState.can('uploading', 'committed')).toBe(false)
	expect(publishBuildState.can('sealed', 'committed')).toBe(true)
	expect(publishBuildState.can('sealed', 'rejected')).toBe(true)
	expect(publishBuildState.can('committed', 'committed')).toBe(true)
	expect(publishBuildState.can('committed', 'rejected')).toBe(true)
	expect(publishBuildState.isTerminal('rejected')).toBe(true)
	expect(publishBuildState.can('rejected', 'committed')).toBe(false)
})
