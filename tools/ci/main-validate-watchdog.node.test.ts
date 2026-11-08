import { expect, test } from 'vitest'
import {
	decideMainValidateRecovery,
	missingPushGraceMs,
	runMainValidateWatchdog,
	type Gh,
} from './main-validate-watchdog.ts'

const committedAt = '2026-11-06T10:38:53Z'
const committedAtMs = Date.parse(committedAt)

type FakeRun = {
	event: string
	head_branch: string
	actor?: { login: string }
}

function fakeGh(runs: Array<FakeRun>, headAfterCheck = 'abc123') {
	const calls: Array<Array<string>> = []
	const gh: Gh = (args) => {
		calls.push(args)
		if (args[0] === 'api' && args[1]?.endsWith('/commits/main')) {
			if (args.includes('--jq')) return `${headAfterCheck}\n`
			return JSON.stringify({
				sha: 'abc123',
				commit: { committer: { date: committedAt } },
			})
		}
		if (args[0] === 'api') return JSON.stringify({ workflow_runs: runs })
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
	const missing = fakeGh([])
	expect(
		runMainValidateWatchdog({ repo: 'o/r', gh: missing.gh, now }).decision
			.action,
	).toBe('dispatch')
	expect(missing.calls[1]?.[1]).toBe(
		'repos/o/r/actions/workflows/validate.yml/runs?head_sha=abc123&branch=main&per_page=100',
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

	const present = fakeGh([{ event: 'push', head_branch: 'main' }])
	runMainValidateWatchdog({ repo: 'o/r', gh: present.gh, now })
	expect(present.calls.some((args) => args[0] === 'workflow')).toBe(false)
})

test('a merge-queue, off-main, or human-dispatched run on the same SHA does not count', () => {
	const now = committedAtMs + missingPushGraceMs * 2
	const queued = fakeGh([
		{ event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-1' },
		{
			event: 'workflow_dispatch',
			head_branch: 'feature',
			actor: { login: 'github-actions[bot]' },
		},
		{
			event: 'workflow_dispatch',
			head_branch: 'main',
			actor: { login: 'a-human' },
		},
	])
	expect(
		runMainValidateWatchdog({ repo: 'o/r', gh: queued.gh, now }).decision
			.action,
	).toBe('dispatch')
	expect(queued.calls.at(-1)?.[0]).toBe('workflow')
})

test('skips the dispatch when main moved while checking', () => {
	const now = committedAtMs + missingPushGraceMs * 2
	const moved = fakeGh([], 'def456')
	const { decision } = runMainValidateWatchdog({
		repo: 'o/r',
		gh: moved.gh,
		now,
	})
	expect(decision.action).toBe('none')
	expect(moved.calls.some((args) => args[0] === 'workflow')).toBe(false)
})

test('a watchdog dispatch on main counts, even after a human re-run', () => {
	const now = committedAtMs + missingPushGraceMs * 2
	const recovered = fakeGh([
		{
			event: 'workflow_dispatch',
			head_branch: 'main',
			actor: { login: 'github-actions[bot]' },
		},
	])
	runMainValidateWatchdog({ repo: 'o/r', gh: recovered.gh, now })
	expect(recovered.calls.some((args) => args[0] === 'workflow')).toBe(false)
})
