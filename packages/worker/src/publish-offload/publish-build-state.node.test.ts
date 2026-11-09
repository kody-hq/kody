import { expect, test } from 'vitest'
import { publishBuildState } from './publish-build-state.ts'

test('publish_builds.status preserves the lifecycle graph', () => {
	expect(publishBuildState.initial).toEqual(['uploading'])
	expect(publishBuildState.transitions).toEqual({
		uploading: ['sealed'],
		sealed: ['committed', 'rejected'],
		committed: ['committed', 'rejected'],
		rejected: [],
	})
	expect(publishBuildState.terminal).toEqual(['rejected'])
})
