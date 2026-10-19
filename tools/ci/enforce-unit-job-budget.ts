/**
 * Gate Validate unit legs on wall-clock with a watch threshold and a hard
 * ceiling (Node watch 700s / hard 840s; Workers watch 620s / hard 780s).
 * Measured from a start epoch recorded at the beginning of the same job.
 * Cache hit or miss does not change the caps.
 *
 * Crossing watch emits a GitHub warning annotation and a step-summary line;
 * crossing hard fails the job on pull_request. `--advisory` keeps both as
 * warnings and exits 0 (push to main / manual bench): a slow cold run on
 * main should not turn main red or block the production deploy that follows
 * Validate.
 *
 * Workers also soft-caps each suite attempt at the hard ceiling in Validate
 * and retries once on GNU `timeout` exit 124, or 137 when `--kill-after` must
 * SIGKILL **after** the soft deadline. Exit 137 before the deadline is an
 * early SIGKILL (not retryable). Assertion failures keep their own status
 * and never retry. ADR 0011 isolation is unchanged. On retry, Validate
 * resets the start epoch so the post-suite check measures the successful
 * attempt only (job wall is the 30-minute Workers timeout).
 *
 * Usage:
 *   node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch 1710000000
 *   node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch 1710000000
 *   node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch 1710000000 --advisory
 */
import { appendFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

/** GNU `timeout(1)` exit status when the soft attempt budget fires (TERM). */
export const unitJobAttemptTimeoutExitCode = 124

/**
 * GNU `timeout(1)` exit status when the child is SIGKILL'd (128+9). This is a
 * soft-cap timeout only when elapsed time has reached the attempt budget
 * (`--kill-after`); an early OS kill before the deadline is not retryable.
 */
export const unitJobAttemptKillAfterExitCode = 137

/** Grace period after the soft deadline before `--kill-after` sends SIGKILL. */
export const unitJobAttemptKillAfterSeconds = 60

/**
 * Timing from Validate runs Oct 4–18 2026 (success+failure jobs with
 * durations; 4x x64 runners). Node job wall n=767 p50≈426 p90≈639 p95≈659
 * max≈751; Workers n=767 p50≈347 p90≈552 p95≈564 max≈604. Watch ≈ p95 +
 * headroom; hard ≈ much higher ceiling under the job `timeout-minutes`.
 */
const unitJobBudgets = {
	node: {
		leg: 'node',
		jobName: '🧪 Node',
		/** Near Node p95 (~653–659s) + ~7% headroom. */
		watchSeconds: 700,
		/**
		 * Hard fail under Node `timeout-minutes: 15` (900s). ~p95×1.28; above
		 * every Oct 4–18 variance trip (budget fails peaked at 741s).
		 */
		maxSeconds: 840,
	},
	workers: {
		leg: 'workers',
		jobName: '☁️ Workers',
		/** Near Workers p95 (~564s) + ~10% headroom. */
		watchSeconds: 620,
		/**
		 * Hard fail / attempt soft-cap under Workers `timeout-minutes: 30`.
		 * Well above historical max (~604s); room for one retry.
		 */
		maxSeconds: 780,
	},
} as const

export type UnitJobLeg = keyof typeof unitJobBudgets

/** Hard ceiling (PR fail / Workers attempt soft-cap). */
export function getUnitJobMaxSeconds(leg: UnitJobLeg) {
	return unitJobBudgets[leg].maxSeconds
}

/** Watch threshold (warning annotation + step summary). */
export function getUnitJobWatchSeconds(leg: UnitJobLeg) {
	return unitJobBudgets[leg].watchSeconds
}

export type UnitJobAttemptExitTiming = {
	/** Wall-clock seconds the attempt ran before exiting. */
	elapsedSeconds: number
	/** Soft-cap duration passed to `timeout` for this attempt. */
	budgetSeconds: number
}

/**
 * Soft-cap overruns are retryable once; assertion failures and early SIGKILL
 * (137 before the soft deadline) are not.
 */
export function isRetryableUnitJobAttemptExit(
	status: number,
	timing?: UnitJobAttemptExitTiming,
) {
	if (status === unitJobAttemptTimeoutExitCode) {
		return true
	}
	if (status === unitJobAttemptKillAfterExitCode) {
		if (!timing) {
			return false
		}
		return timing.elapsedSeconds >= timing.budgetSeconds
	}
	return false
}

export type UnitJobBudgetLevel = 'ok' | 'watch' | 'fail'

export type UnitJobBudgetResult = {
	/** False only when elapsed exceeds the hard ceiling. */
	ok: boolean
	level: UnitJobBudgetLevel
	leg: UnitJobLeg
	jobName: string
	elapsedSeconds: number
	watchSeconds: number
	maxSeconds: number
	summary: string
	/** Always-present elapsed vs thresholds line for step summary / logs. */
	thresholdLine: string
}

export function isUnitJobLeg(value: string): value is UnitJobLeg {
	return value === 'node' || value === 'workers'
}

export function evaluateUnitJobBudget(input: {
	leg: UnitJobLeg
	startEpochSeconds: number
	nowEpochSeconds?: number
}): UnitJobBudgetResult {
	const budget = unitJobBudgets[input.leg]
	const now =
		typeof input.nowEpochSeconds === 'number'
			? input.nowEpochSeconds
			: Math.floor(Date.now() / 1000)
	const elapsedSeconds = Math.max(0, now - input.startEpochSeconds)
	const overHard = elapsedSeconds > budget.maxSeconds
	const overWatch = elapsedSeconds > budget.watchSeconds
	const level: UnitJobBudgetLevel = overHard
		? 'fail'
		: overWatch
			? 'watch'
			: 'ok'
	const thresholdLine = `${budget.jobName}: elapsed ${elapsedSeconds}s | watch ${budget.watchSeconds}s | hard ${budget.maxSeconds}s | ${level}`
	const summary = overHard
		? `${budget.jobName} took ${elapsedSeconds}s; hard ceiling is ${budget.maxSeconds}s (watch ${budget.watchSeconds}s). Speed up the suite - do not delete or skip tests to game the budget.`
		: overWatch
			? `${budget.jobName} took ${elapsedSeconds}s; crossed watch ${budget.watchSeconds}s (hard ${budget.maxSeconds}s).`
			: `${budget.jobName} finished in ${elapsedSeconds}s (watch ${budget.watchSeconds}s, hard ${budget.maxSeconds}s).`
	return {
		ok: !overHard,
		level,
		leg: input.leg,
		jobName: budget.jobName,
		elapsedSeconds,
		watchSeconds: budget.watchSeconds,
		maxSeconds: budget.maxSeconds,
		summary,
		thresholdLine,
	}
}

function appendStepSummary(line: string) {
	const path = process.env.GITHUB_STEP_SUMMARY
	if (!path) return
	appendFileSync(path, `${line}\n`, 'utf8')
}

function readFlag(args: Array<string>, name: string) {
	const index = args.indexOf(name)
	if (index === -1) return null
	const value = args[index + 1]
	if (!value || value.startsWith('--')) return null
	return value
}

export function main(args = process.argv.slice(2)) {
	const legRaw = readFlag(args, '--leg')
	const startRaw = readFlag(args, '--start-epoch')
	if (!legRaw || !isUnitJobLeg(legRaw) || !startRaw) {
		console.error(
			'Usage: node tools/ci/enforce-unit-job-budget.ts --leg <node|workers> --start-epoch <unix-seconds> [--advisory]',
		)
		process.exitCode = 1
		return
	}
	const startEpochSeconds = Number(startRaw)
	if (!Number.isFinite(startEpochSeconds)) {
		console.error(`Invalid --start-epoch: ${startRaw}`)
		process.exitCode = 1
		return
	}

	const result = evaluateUnitJobBudget({
		leg: legRaw,
		startEpochSeconds,
	})
	const advisory = args.includes('--advisory')

	console.log(result.thresholdLine)
	appendStepSummary(`### Unit job budget\n- ${result.thresholdLine}`)

	if (result.level === 'ok') {
		console.log(result.summary)
		process.exitCode = 0
		return
	}

	if (result.level === 'watch') {
		console.log(
			`::warning title=${result.jobName} over watch threshold::${result.summary}`,
		)
		process.exitCode = 0
		return
	}

	// hard fail
	if (advisory) {
		console.log(
			`::warning title=${result.jobName} over hard ceiling (advisory)::${result.summary}`,
		)
		process.exitCode = 0
		return
	}
	console.error(result.summary)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
