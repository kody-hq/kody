import { expect, test } from 'vitest'
import { repoSessionState } from './repo-session-state.ts'

test('repo_sessions.status preserves the accepted lifecycle graph', () => {
	expect(repoSessionState.initial).toEqual(['active', 'published', 'discarded'])
	expect(repoSessionState.transitions).toEqual({
		active: ['active', 'published', 'discarded'],
		published: ['active', 'published', 'discarded'],
		discarded: ['active', 'published', 'discarded'],
	})
	expect(repoSessionState.terminal).toEqual([])
})
