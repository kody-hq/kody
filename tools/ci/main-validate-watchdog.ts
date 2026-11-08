import { spawnSync } from 'node:child_process'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * GitHub occasionally drops the `push` event for a merge to main (#4929: a
 * squash-merge retried after "405 merge already in progress"). With no
 * Validate run on main HEAD, Deploy never starts and production stays behind
 * until the next merge. `.github/workflows/main-validate-watchdog.yml` runs
 * this on a schedule: when main HEAD is old enough to have had its push run
 * and no ✅ Validate run exists for it at all, it dispatches Validate on main.
 * Deploy accepts that dispatched run like a push run, and sha-guard still
 * refuses anything that is not forward of production.
 *
 *   GH_TOKEN=... node tools/ci/main-validate-watchdog.ts
 */

export const validateWorkflowFile = 'validate.yml'
export const missingPushGraceMs = 10 * 60 * 1000

export type Gh = (args: Array<string>) => string

export type WatchdogDecision =
	| { action: 'dispatch'; reason: string }
	| { action: 'none'; reason: string }

export function decideMainValidateRecovery(input: {
	headSha: string
	committedAt: string
	now: number
	validateRunCount: number
}): WatchdogDecision {
	if (input.validateRunCount > 0) {
		return {
			action: 'none',
			reason: `main HEAD ${input.headSha} already has ${input.validateRunCount} Validate run(s)`,
		}
	}
	const committedAtMs = Date.parse(input.committedAt)
	if (!Number.isFinite(committedAtMs)) {
		return {
			action: 'none',
			reason: `main HEAD ${input.headSha} has an unreadable commit date`,
		}
	}
	const ageMs = input.now - committedAtMs
	if (ageMs < missingPushGraceMs) {
		return {
			action: 'none',
			reason: `main HEAD ${input.headSha} is ${Math.round(ageMs / 1000)}s old; waiting for its push run`,
		}
	}
	return {
		action: 'dispatch',
		reason: `main HEAD ${input.headSha} is ${Math.round(ageMs / 60_000)} min old with no Validate run`,
	}
}

export function runMainValidateWatchdog(input: {
	repo: string
	gh: Gh
	now: number
}) {
	const head = JSON.parse(
		input.gh(['api', `repos/${input.repo}/commits/main`]),
	) as { sha: string; commit: { committer: { date: string } } }
	const runs = JSON.parse(
		input.gh([
			'api',
			`repos/${input.repo}/actions/workflows/${validateWorkflowFile}/runs?head_sha=${head.sha}&per_page=1`,
		]),
	) as { total_count: number }
	const decision = decideMainValidateRecovery({
		headSha: head.sha,
		committedAt: head.commit.committer.date,
		now: input.now,
		validateRunCount: runs.total_count,
	})
	if (decision.action === 'dispatch') {
		input.gh([
			'workflow',
			'run',
			validateWorkflowFile,
			'--repo',
			input.repo,
			'--ref',
			'main',
			'-f',
			'no_cache=false',
		])
	}
	return { headSha: head.sha, decision }
}

function gh(args: Array<string>) {
	const run = spawnSync('gh', args, { encoding: 'utf8' })
	if (run.status !== 0) {
		throw new Error(run.stderr || `gh ${args.join(' ')} failed`)
	}
	return run.stdout
}

if (isExecutedDirectly(import.meta.url)) {
	const repo = process.env.GITHUB_REPOSITORY ?? 'kody-hq/kody'
	const { decision } = runMainValidateWatchdog({ repo, gh, now: Date.now() })
	if (decision.action === 'dispatch') {
		console.log(
			`::warning title=Missing main push run::${decision.reason}; dispatched ✅ Validate on main.`,
		)
	} else {
		console.log(decision.reason)
	}
}
