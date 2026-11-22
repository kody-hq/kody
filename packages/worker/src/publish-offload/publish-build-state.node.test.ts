import {
	canHandle,
	finalStatesOf,
} from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { publishBuildState } from './publish-build-state.ts'

test('publish builds seal before commit, and committed builds may re-finalize or reject', () => {
	expect(canHandle(publishBuildState, 'uploading', 'SEAL')).toBe(true)
	expect(canHandle(publishBuildState, 'uploading', 'COMMIT')).toBe(false)
	expect(canHandle(publishBuildState, 'sealed', 'COMMIT')).toBe(true)
	expect(canHandle(publishBuildState, 'sealed', 'REJECT')).toBe(true)
	expect(canHandle(publishBuildState, 'committed', 'COMMIT')).toBe(true)
	expect(canHandle(publishBuildState, 'committed', 'REJECT')).toBe(true)
	expect(finalStatesOf(publishBuildState).includes('rejected')).toBe(true)
	expect(canHandle(publishBuildState, 'rejected', 'COMMIT')).toBe(false)
})

test('only an uploading build may be abandoned, and abandoned is final', () => {
	expect(canHandle(publishBuildState, 'uploading', 'ABANDON')).toBe(true)
	for (const status of ['sealed', 'committed', 'rejected'] as const) {
		expect(canHandle(publishBuildState, status, 'ABANDON')).toBe(false)
	}
	expect(finalStatesOf(publishBuildState).includes('abandoned')).toBe(true)
	expect(canHandle(publishBuildState, 'abandoned', 'SEAL')).toBe(false)
	expect(canHandle(publishBuildState, 'abandoned', 'COMMIT')).toBe(false)
})
