import { expect, test } from 'vitest'
import {
	decideMainValidateRecovery,
	missingPushGraceMs,
	runMainValidateWatchdog,
	type Gh,
} from './main-validate-watchdog.ts'

const committedAt = '2026-11-06T10:38:53Z'
const committedAtMs = Date.parse(committedAt)

function fakeGh(runCount: number) {
	const calls: Array<Array<string>> = []
	const gh: Gh = (args) => {
		calls.push(args)
		if (args[0] === 'api' && args[1]?.endsWith('/commits/main')) {
			return JSON.stringify({
				sha: 'abc123',
				commit: { committer: { date: committedAt } },
			})
		}
		if (args[0] === 'api') return JSON.stringify({ total_count: runCount })
		return ''
	}
	return { gh, calls }
}

test('dispatches Validate on main only when an old enough HEAD has no run', () => {
	const late = committedAtMs + missingPushGraceMs + 1000
	expect(
		decideMainValidateRecovery({
			headSha: 'abc',
			committedAt,
			now: late,
			validateRunCount: 0,
		}).action,
	).toBe('dispatch')
	expect(
		decideMainValidateRecovery({
			headSha: 'abc',
			committedAt,
			now: late,
			validateRunCount: 1,
		}).action,
	).toBe('none')
	expect(
		decideMainValidateRecovery({
			headSha: 'abc',
			committedAt,
			now: committedAtMs + missingPushGraceMs - 1000,
			validateRunCount: 0,
		}).action,
	).toBe('none')
	expect(
		decideMainValidateRecovery({
			headSha: 'abc',
			committedAt: 'nope',
			now: late,
			validateRunCount: 0,
		}).action,
	).toBe('none')
})

test('the dispatch targets main with caching on', () => {
	const now = committedAtMs + missingPushGraceMs * 2
	const missing = fakeGh(0)
	expect(
		runMainValidateWatchdog({ repo: 'o/r', gh: missing.gh, now }).decision
			.action,
	).toBe('dispatch')
	expect(missing.calls[1]?.[1]).toBe(
		'repos/o/r/actions/workflows/validate.yml/runs?head_sha=abc123&per_page=1',
	)
	expect(missing.calls.at(-1)).toEqual([
		'workflow',
		'run',
		'validate.yml',
		'--repo',
		'o/r',
		'--ref',
		'main',
		'-f',
		'no_cache=false',
	])

	const present = fakeGh(2)
	runMainValidateWatchdog({ repo: 'o/r', gh: present.gh, now })
	expect(present.calls.some((args) => args[0] === 'workflow')).toBe(false)
})
