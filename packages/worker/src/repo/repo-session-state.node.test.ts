import { expect, test } from 'vitest'
import { repoSessionState } from './repo-session-state.ts'

test('repo session storage accepts every status replacement, including repeated finalization', () => {
	for (const from of repoSessionState.values)
		for (const to of repoSessionState.values)
			expect(
				repoSessionState.is(from) && repoSessionState.is(to),
				`${from} -> ${to}`,
			).toBe(true)
})
