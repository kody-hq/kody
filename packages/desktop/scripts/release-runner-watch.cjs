const {
	githubDelaysMs,
	runWithRetry,
	sleepSync,
} = require('./release-retry.cjs')

// GitHub sometimes never assigns a hosted runner (usually macOS arm64) to a
// build leg, which cancels it with no steps. The runner watch workflows run
// this after a Desktop release or Desktop binaries run ends unsuccessfully: it
// re-runs failed jobs while the only failures are build legs no runner picked
// up and waits for each attempt. A release fails loudly naming the missing
// targets when attempts run out or a leg failed for a real reason; for
// Desktop binaries a real failure is already the red check, so the watch
// only steps aside.

const maxAttempts = 4
const pollMs = 60_000
const notAcquired = /was not acquired by Runner/

const watches = {
	release: {
		workflowFile: 'desktop-release.yml',
		title: 'Desktop release',
		isLeg: (name) => name.startsWith('Release '),
		// Shortages come in bursts, so wait longer before each later attempt.
		rerunDelaysMs: [5 * 60_000, 15 * 60_000, 30 * 60_000],
		failOnRealFailure: true,
		superseded: (newerRun) =>
			`Desktop release run ${newerRun.id} for newer main ${newerRun.head_sha} supersedes this source; it publishes the next version and removes this draft.`,
		noFailedLeg:
			'Every build leg finished but publication failed; see the publish job log.',
		exhausted: (names, attempt) =>
			`${names} got no hosted runner in ${attempt} attempts, so the release stays a draft without those targets.`,
	},
	binaries: {
		workflowFile: 'desktop-binaries.yml',
		title: 'Desktop binaries',
		isLeg: (name) => /^(mac|win|linux) \S+$/.test(name),
		// A re-run keeps its ref, so it would cancel a newer run on that ref
		// (such as a dispatch at the same commit) through the concurrency group.
		sameShaSupersedes: true,
		// A pull request waits on this check, so retry sooner.
		rerunDelaysMs: [60_000, 5 * 60_000, 15 * 60_000],
		failOnRealFailure: false,
		superseded: (newerRun) =>
			`Desktop binaries run ${newerRun.id} for newer ${newerRun.head_sha} on the same branch supersedes this one.`,
		noFailedLeg: 'No build leg failed; nothing to re-run.',
		exhausted: (names, attempt) =>
			`${names} got no hosted runner in ${attempt} attempts; re-run Desktop binaries once runners are available.`,
	},
}

function decideRerun({
	attempt,
	jobs,
	annotations,
	newerRun,
	watch = watches.release,
}) {
	if (newerRun) return { action: 'none', reason: watch.superseded(newerRun) }
	const failed = jobs.filter(
		(job) =>
			watch.isLeg(job.name) && !['success', 'skipped'].includes(job.conclusion),
	)
	if (!failed.length)
		return {
			action: watch.failOnRealFailure ? 'fail' : 'none',
			reason: watch.noFailedLeg,
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
			action: watch.failOnRealFailure ? 'fail' : 'none',
			reason: `${real.map((job) => `${job.name} ended ${job.conclusion}`).join(', ')}; only legs no runner picked up are re-run.`,
		}
	const names = failed.map((job) => job.name).join(', ')
	if (attempt >= maxAttempts)
		return { action: 'fail', reason: watch.exhausted(names, attempt) }
	return {
		action: 'rerun',
		reason: `${names} got no hosted runner on attempt ${attempt}; re-running failed jobs.`,
		delayMs: watch.rerunDelaysMs[attempt - 1],
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
	watch = watches.release,
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
				`${watch.title} run ${runId} succeeded on attempt ${run.run_attempt}.`,
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
		const findNewerRun = () =>
			json([
				'api',
				`repos/${repo}/actions/workflows/${watch.workflowFile}/runs?branch=${encodeURIComponent(run.head_branch ?? 'main')}&per_page=20`,
			]).workflow_runs.find(
				(other) =>
					other.id !== run.id &&
					other.head_repository?.full_name === run.head_repository?.full_name &&
					(watch.sameShaSupersedes || other.head_sha !== run.head_sha) &&
					Date.parse(other.created_at) > Date.parse(run.created_at),
			)
		const decision = decideRerun({
			attempt: run.run_attempt,
			jobs,
			annotations,
			newerRun: findNewerRun(),
			watch,
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
			`::warning title=${watch.title} runner shortage::${decision.reason} Waiting ${decision.delayMs / 60_000} min first.`,
		)
		sleep(decision.delayMs)
		// A run that started during the wait replaces this one; re-running this
		// one would cancel it through the workflow's concurrency group.
		const newerRun = findNewerRun()
		if (newerRun) {
			log(watch.superseded(newerRun))
			return { action: 'none', attempt: run.run_attempt }
		}
		gh(['run', 'rerun', String(runId), '--failed', '--repo', repo])
		while (
			json(['api', `repos/${repo}/actions/runs/${runId}`]).run_attempt ===
			run.run_attempt
		)
			sleep(pollMs)
	}
}

module.exports = { decideRerun, maxAttempts, watchRelease, watches }

if (require.main === module) {
	const watch = watches[process.env.WATCH_KIND ?? 'release']
	try {
		if (!watch) throw new Error(`Unknown WATCH_KIND ${process.env.WATCH_KIND}.`)
		watchRelease({
			repo: process.env.GITHUB_REPOSITORY,
			runId: process.env.WATCHED_RUN_ID ?? process.env.RELEASE_RUN_ID,
			watch,
		})
	} catch (error) {
		console.log(
			`::error title=${watch?.title ?? 'Desktop'} incomplete::${error.message}`,
		)
		process.exitCode = 1
	}
}
