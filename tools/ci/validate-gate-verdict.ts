/**
 * ✅ Validate gate verdict from `toJSON(needs)`.
 *
 * Every job must succeed, except two recoveries that keep coverage:
 * - a Workers shard whose first attempt hit the attempt budget passes when its
 *   fresh-runner retry (`workers_retry`) passes;
 * - `host_commands_macos` that GitHub never assigned a runner (`abandoned`)
 *   passes when `host_commands_macos_fallback` (macos-15-intel) passes.
 *
 * A job that never got a runner is `infra`, not a code failure: it gets its own
 * annotation, and the gate still fails so an unverified tree is never stamped.
 *
 *   NEEDS='${{ toJSON(needs) }}' node tools/ci/validate-gate-verdict.ts
 */
import { appendFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

type Need = { result?: string; outputs?: Record<string, string | undefined> }
export type Needs = Record<string, Need | undefined>
export type Verdict = 'pass' | 'infra' | 'fail'
export type JobVerdict = { job: string; verdict: Verdict; detail: string }

const neverAssigned = 'abandoned'
const workersShards = [1, 2]
const recoveryJobs = new Set([
	'tested_tree',
	'workers',
	'workers_retry',
	'host_commands_macos',
	'host_commands_macos_fallback',
])

function plain(job: string, need: Need | undefined): JobVerdict {
	const result = need?.result ?? 'missing'
	if (result === 'success') return { job, verdict: 'pass', detail: 'success' }
	if (result === neverAssigned) {
		return {
			job,
			verdict: 'infra',
			detail: 'never assigned a runner (abandoned)',
		}
	}
	return { job, verdict: 'fail', detail: result }
}

function workersShard(needs: Needs, shard: number): JobVerdict {
	const job = `workers ${shard}/2`
	const first = needs.workers?.outputs?.[`outcome_${shard}`]
	if (first === 'pass') return { job, verdict: 'pass', detail: 'passed' }
	if (!first) {
		return needs.workers?.result === neverAssigned
			? { job, verdict: 'infra', detail: 'never assigned a runner (abandoned)' }
			: {
					job,
					verdict: 'fail',
					detail: `no outcome reported (workers=${needs.workers?.result ?? 'missing'})`,
				}
	}
	if (first !== 'timeout') {
		return { job, verdict: 'fail', detail: `attempt 1 ${first}` }
	}
	const retry = needs.workers_retry?.outputs?.[`outcome_${shard}`]
	if (retry === 'pass') {
		return {
			job,
			verdict: 'pass',
			detail: 'attempt 1 hit the budget; passed on a fresh runner',
		}
	}
	if (!retry && needs.workers_retry?.result === neverAssigned) {
		return {
			job,
			verdict: 'infra',
			detail: 'attempt 1 hit the budget; retry never assigned a runner',
		}
	}
	return {
		job,
		verdict: 'fail',
		detail: `attempt 1 hit the budget; retry ${retry ?? needs.workers_retry?.result ?? 'missing'}`,
	}
}

function macos(needs: Needs): JobVerdict {
	const job = 'host_commands_macos'
	const primary = needs.host_commands_macos?.result ?? 'missing'
	if (primary === 'success') return { job, verdict: 'pass', detail: 'success' }
	if (primary !== neverAssigned)
		return { job, verdict: 'fail', detail: primary }
	const fallback = needs.host_commands_macos_fallback?.result ?? 'missing'
	if (fallback === 'success') {
		return {
			job,
			verdict: 'pass',
			detail: 'macos-15 never assigned a runner; passed on macos-15-intel',
		}
	}
	if (fallback === neverAssigned) {
		return {
			job,
			verdict: 'infra',
			detail: 'neither macos-15 nor macos-15-intel was assigned a runner',
		}
	}
	return {
		job,
		verdict: 'fail',
		detail: `macos-15 never assigned a runner; macos-15-intel fallback ${fallback}`,
	}
}

export function classifyValidateNeeds(needs: Needs) {
	const jobs: Array<JobVerdict> = [
		...Object.keys(needs)
			.filter((job) => !recoveryJobs.has(job))
			.map((job) => plain(job, needs[job])),
		...workersShards.map((shard) => workersShard(needs, shard)),
		macos(needs),
	]
	const verdict: Verdict = jobs.some((job) => job.verdict === 'fail')
		? 'fail'
		: jobs.some((job) => job.verdict === 'infra')
			? 'infra'
			: 'pass'
	return { verdict, jobs }
}

export function renderVerdict(
	result: ReturnType<typeof classifyValidateNeeds>,
) {
	const annotations = result.jobs.flatMap((job) => {
		if (job.verdict === 'fail') {
			return [`::error title=Validate failed: ${job.job}::${job.detail}`]
		}
		if (job.verdict === 'infra') {
			return [
				`::error title=CI infrastructure, not a code failure: ${job.job}::${job.detail}. No code ran; re-run the job once a runner is available.`,
			]
		}
		return job.detail === 'success' || job.detail === 'passed'
			? []
			: [`::notice title=Recovered: ${job.job}::${job.detail}`]
	})
	const icon = { pass: '✅', infra: '🏗️', fail: '❌' }
	const heading = {
		pass: '✅ All checks passed',
		infra:
			'🏗️ CI infrastructure: a job never got a runner (not a code failure)',
		fail: '❌ Validate failed',
	}[result.verdict]
	const summary = [
		`### ${heading}`,
		'',
		'| Job | Verdict | Detail |',
		'| --- | --- | --- |',
		...result.jobs.map(
			(job) =>
				`| ${job.job} | ${icon[job.verdict]} ${job.verdict} | ${job.detail} |`,
		),
		'',
	].join('\n')
	return { annotations, summary }
}

if (isExecutedDirectly(import.meta.url)) {
	const result = classifyValidateNeeds(JSON.parse(process.env.NEEDS ?? '{}'))
	const { annotations, summary } = renderVerdict(result)
	for (const line of annotations) console.log(line)
	for (const job of result.jobs)
		console.log(`${job.job}=${job.verdict} (${job.detail})`)
	if (process.env.GITHUB_STEP_SUMMARY) {
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
	}
	process.exitCode = result.verdict === 'pass' ? 0 : 1
}
