import { expect, test } from 'vitest'
import { commitsAfter } from './artifact-commit-log.ts'

function entry(oid: string, message: string, timestamp = 1_700_000_000) {
	return { oid, commit: { message, author: { timestamp } } }
}

test('commitsAfter stops at the published commit, newest first', () => {
	const log = [
		entry('c'.repeat(40), 'Third\n\nbody'),
		entry('b'.repeat(40), 'Second'),
		entry('a'.repeat(40), 'First'),
	]
	expect(commitsAfter(log, 'B'.repeat(40), 20)).toEqual({
		truncated: false,
		commits: [
			{
				commit: 'c'.repeat(40),
				subject: 'Third',
				authoredAt: '2023-11-14T22:13:20.000Z',
			},
		],
	})
	expect(commitsAfter(log, null, 20)?.commits).toHaveLength(3)
})

test('commitsAfter flags truncation when more commits wait than the limit', () => {
	const log = [
		entry('c'.repeat(40), 'Third'),
		entry('b'.repeat(40), 'Second'),
		entry('a'.repeat(40), 'First'),
	]
	const result = commitsAfter(log, 'a'.repeat(40), 1)
	expect(result?.truncated).toBe(true)
	expect(result?.commits.map((c) => c.subject)).toEqual(['Third'])
	expect(commitsAfter(log, 'a'.repeat(40), 2)).toMatchObject({
		truncated: false,
	})
})

test('commitsAfter returns null when head history never reaches the published commit', () => {
	const log = [entry('c'.repeat(40), 'third'), entry('a'.repeat(40), 'first')]
	expect(commitsAfter(log, 'f'.repeat(40), 20)).toBeNull()
})
