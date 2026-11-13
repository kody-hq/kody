const assert = require('node:assert/strict')
const { test } = require('node:test')
const {
	decideRerun,
	maxAttempts,
	watchRelease,
} = require('../scripts/release-runner-watch.cjs')

const repo = 'kody-hq/kody'
const noRunner = [
	'The job was not acquired by Runner of type hosted even after multiple attempts',
]
const job = (id, name, conclusion) => ({ id, name, conclusion })
const starvedArm = [
	job(1, 'credentials', 'success'),
	job(2, 'Release mac arm64', 'cancelled'),
	job(3, 'Release mac x64', 'success'),
	job(4, 'publish', 'failure'),
]

test('re-runs while the only failed legs never got a runner', () => {
	const decision = decideRerun({
		attempt: 1,
		jobs: starvedArm,
		annotations: new Map([[2, noRunner]]),
	})
	assert.equal(decision.action, 'rerun')
	assert.match(decision.reason, /Release mac arm64 got no hosted runner/)
})

test('a leg that ran and failed is reported, not re-run', () => {
	for (const [conclusion, annotations] of [
		['failure', new Map()],
		['cancelled', new Map([[2, ['The operation was canceled.']]])],
	]) {
		const decision = decideRerun({
			attempt: 1,
			jobs: [job(2, 'Release mac arm64', conclusion)],
			annotations,
		})
		assert.equal(decision.action, 'fail')
		assert.equal(
			decision.reason,
			`Release mac arm64 ended ${conclusion}; only legs no runner picked up are re-run.`,
		)
	}
})

test('a publish failure after every leg built is reported, not re-run', () => {
	const decision = decideRerun({
		attempt: 1,
		jobs: [job(3, 'Release mac x64', 'success'), job(4, 'publish', 'failure')],
		annotations: new Map(),
	})
	assert.equal(decision.action, 'fail')
})

test('stops naming the starved target once attempts run out', () => {
	const decision = decideRerun({
		attempt: maxAttempts,
		jobs: starvedArm,
		annotations: new Map([[2, noRunner]]),
	})
	assert.equal(decision.action, 'fail')
	assert.equal(
		decision.reason,
		`Release mac arm64 got no hosted runner in ${maxAttempts} attempts, so the release stays a draft without those targets.`,
	)
})

test('a newer main release run supersedes the starved one', () => {
	const decision = decideRerun({
		attempt: 1,
		jobs: starvedArm,
		annotations: new Map([[2, noRunner]]),
		newerRun: { id: 9, head_sha: 'b'.repeat(40) },
	})
	assert.equal(decision.action, 'none')
})

// Attempt 1 starves the arm64 leg, the re-run attempt 2 succeeds.
function fakeGitHub({ attempts }) {
	const state = { attempt: 1, reruns: [], sleeps: 0 }
	const run = () => ({
		id: 5,
		head_sha: 'a'.repeat(40),
		created_at: '2026-11-13T18:45:32Z',
		status: 'completed',
		run_attempt: state.attempt,
		conclusion: attempts[state.attempt - 1].conclusion,
	})
	const gh = (args) => {
		const path = args[1]
		if (args[0] === 'run' && args[1] === 'rerun') {
			state.reruns.push(args.join(' '))
			state.attempt++
			return ''
		}
		if (path === `repos/${repo}/actions/runs/5`) return JSON.stringify(run())
		const jobs = path.match(/runs\/5\/attempts\/(\d+)\/jobs/)
		if (jobs)
			return JSON.stringify({ jobs: attempts[Number(jobs[1]) - 1].jobs })
		if (path.startsWith(`repos/${repo}/check-runs/`))
			return JSON.stringify(noRunner.map((message) => ({ message })))
		if (path.includes('/workflows/desktop-release.yml/runs'))
			return JSON.stringify({ workflow_runs: [run()] })
		throw new Error(`unexpected gh ${args.join(' ')}`)
	}
	return { gh, state }
}

test('watches a re-run through to success', () => {
	const github = fakeGitHub({
		attempts: [
			{ conclusion: 'failure', jobs: starvedArm },
			{ conclusion: 'success', jobs: [] },
		],
	})
	const result = watchRelease({
		repo,
		runId: 5,
		gh: github.gh,
		sleep: () => github.state.sleeps++,
		log: () => {},
	})
	assert.deepEqual(result, { action: 'none', attempt: 2 })
	assert.deepEqual(github.state.reruns, [`run rerun 5 --failed --repo ${repo}`])
})

test('fails loudly after the last starved attempt', () => {
	const github = fakeGitHub({
		attempts: Array.from({ length: maxAttempts }, () => ({
			conclusion: 'failure',
			jobs: starvedArm,
		})),
	})
	assert.throws(
		() =>
			watchRelease({
				repo,
				runId: 5,
				gh: github.gh,
				sleep: () => {},
				log: () => {},
			}),
		/Release mac arm64 got no hosted runner in 4 attempts/,
	)
	assert.equal(github.state.reruns.length, maxAttempts - 1)
})
