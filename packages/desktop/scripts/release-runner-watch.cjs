const {
	githubDelaysMs,
	runWithRetry,
	sleepSync,
} = require('./release-retry.cjs')

// GitHub sometimes never assigns a hosted macOS runner to a build leg, which
// cancels it with no steps and leaves the release draft without that target.
// The Desktop release runner watch workflow runs this after a failed Desktop
// release run: it re-runs failed jobs while the only failures are build legs
// no runner picked up, waits for each attempt, and fails loudly naming the
// missing targets when attempts run out or a leg failed for a real reason.

const workflowFile = 'desktop-release.yml'
const maxAttempts = 4
// Shortages come in bursts, so wait longer before each later attempt.
const rerunDelaysMs = [5 * 60_000, 15 * 60_000, 30 * 60_000]
const pollMs = 60_000
const notAcquired = /was not acquired by Runner/

function decideRerun({ attempt, jobs, annotations, newerRun }) {
	if (newerRun)
		return {
			action: 'none',
			reason: `Desktop release run ${newerRun.id} for newer main ${newerRun.head_sha} supersedes this source; it publishes the next version and removes this draft.`,
		}
	const failed = jobs.filter(
		(job) =>
			job.name.startsWith('Release ') &&
			!['success', 'skipped'].includes(job.conclusion),
	)
	if (!failed.length)
		return {
			action: 'fail',
			reason:
				'Every build leg finished but publication failed; see the publish job log.',
		}
	const real = failed.filter(
		(job) =>
			job.conclusion !== 'cancelled' ||
			!(annotations.get(job.id) ?? []).some((message) =>
				notAcquired.test(message),
			),
	)
	if (real.length)
		return {
			action: 'fail',
			reason: `${real.map((job) => `${job.name} ended ${job.conclusion}`).join(', ')}; only legs no runner picked up are re-run.`,
		}
	const names = failed.map((job) => job.name).join(', ')
	if (attempt >= maxAttempts)
		return {
			action: 'fail',
			reason: `${names} got no hosted runner in ${attempt} attempts, so the release stays a draft without those targets.`,
		}
	return {
		action: 'rerun',
		reason: `${names} got no hosted runner on attempt ${attempt}; re-running failed jobs.`,
		delayMs: rerunDelaysMs[attempt - 1],
	}
}

function defaultGh(args) {
	return runWithRetry('gh', args, {
		delaysMs: githubDelaysMs,
		echo: false,
		label: `gh ${args.slice(0, 2).join(' ')}`,
	}).result.stdout
}

function watchRelease({
	repo,
	runId,
	gh = defaultGh,
	sleep = sleepSync,
	log = (line) => process.stdout.write(`${line}\n`),
}) {
	const json = (args) => JSON.parse(gh(args))
	for (;;) {
		const run = json(['api', `repos/${repo}/actions/runs/${runId}`])
		if (run.status !== 'completed') {
			sleep(pollMs)
			continue
		}
		if (run.conclusion === 'success') {
			log(
				`Desktop release run ${runId} succeeded on attempt ${run.run_attempt}.`,
			)
			return { action: 'none', attempt: run.run_attempt }
		}
		const jobs = json([
			'api',
			`repos/${repo}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
		]).jobs
		const annotations = new Map(
			jobs
				.filter((job) => job.conclusion === 'cancelled')
				.map((job) => [
					job.id,
					json(['api', `repos/${repo}/check-runs/${job.id}/annotations`]).map(
						(annotation) => annotation.message,
					),
				]),
		)
		const newerRun = json([
			'api',
			`repos/${repo}/actions/workflows/${workflowFile}/runs?branch=main&per_page=20`,
		]).workflow_runs.find(
			(other) =>
				other.id !== run.id &&
				other.head_sha !== run.head_sha &&
				Date.parse(other.created_at) > Date.parse(run.created_at),
		)
		const decision = decideRerun({
			attempt: run.run_attempt,
			jobs,
			annotations,
			newerRun,
		})
		if (decision.action === 'none') {
			log(decision.reason)
			return { action: 'none', attempt: run.run_attempt }
		}
		if (decision.action === 'fail') {
			const error = new Error(decision.reason)
			error.attempt = run.run_attempt
			throw error
		}
		log(
			`::warning title=Desktop release runner shortage::${decision.reason} Waiting ${decision.delayMs / 60_000} min first.`,
		)
		sleep(decision.delayMs)
		gh(['run', 'rerun', String(runId), '--failed', '--repo', repo])
		while (
			json(['api', `repos/${repo}/actions/runs/${runId}`]).run_attempt ===
			run.run_attempt
		)
			sleep(pollMs)
	}
}

module.exports = { decideRerun, maxAttempts, watchRelease }

if (require.main === module) {
	try {
		watchRelease({
			repo: process.env.GITHUB_REPOSITORY,
			runId: process.env.RELEASE_RUN_ID,
		})
	} catch (error) {
		console.log(`::error title=Desktop release incomplete::${error.message}`)
		process.exitCode = 1
	}
}
