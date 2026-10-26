import { expect, test } from 'vitest'
import { describeFollowRecentUpdate, followUnhandledEvents } from './follows.ts'

test('recent update summaries name the version or the pushed commits', () => {
	expect(
		describeFollowRecentUpdate({
			event: 'published',
			publishedCommit: 'abcdef1234',
			previousCommit: null,
		}),
	).toBe('Published version abcdef1')
	expect(
		describeFollowRecentUpdate({
			event: 'pushed',
			ref: 'refs/heads/main',
			afterCommit: 'c3',
			totalCommits: 3,
			latestMessage: 'Fix typo\n\nbody',
		}),
	).toBe('3 commits pushed to main: Fix typo')
	expect(
		describeFollowRecentUpdate({
			event: 'pushed',
			ref: 'refs/heads/dev',
			afterCommit: null,
			totalCommits: 1,
			latestMessage: null,
		}),
	).toBe('1 commit pushed to dev')
})

test('only an active follow’s selected events can be unhandled', () => {
	expect(
		followUnhandledEvents({ status: 'active', events: ['pushed'] }, [
			'published',
			'pushed',
		]),
	).toEqual(['pushed'])
	expect(
		followUnhandledEvents({ status: 'paused', events: ['pushed'] }, ['pushed']),
	).toEqual([])
})
