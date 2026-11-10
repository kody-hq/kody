import { expect, test } from 'vitest'
import { repoSessionState } from './repo-session-state.ts'

test('repo session storage accepts every status replacement, including repeated finalization', () => {
	const replace = (from: string, to: 'published' | 'discarded') =>
		repoSessionState.parse(repoSessionState.is(from) ? to : from)
	expect(replace('active', 'published')).toBe('published')
	expect(replace('published', 'published')).toBe('published')
	expect(replace('published', 'discarded')).toBe('discarded')
	expect(replace('discarded', 'discarded')).toBe('discarded')
	expect(() => repoSessionState.parse('running')).toThrow(
		'repo_sessions.status',
	)
})
