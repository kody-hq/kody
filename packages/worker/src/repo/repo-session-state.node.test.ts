import { expect, test } from 'vitest'
import { repoSessionState } from './repo-session-state.ts'

test('repo session storage accepts every status replacement, including repeated finalization', () => {
	for (const from of repoSessionState.states)
		for (const to of repoSessionState.states)
			expect(repoSessionState.can(from, to), `${from} -> ${to}`).toBe(true)
})
