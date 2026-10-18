/**
 * Fail a Validate unit leg when wall-clock exceeds the cold-run baseline
 * budget (Node ≤720s, Workers ≤720s). Measured from a start epoch recorded at
 * the beginning of the same job. Cache hit or miss does not change the cap.
 *
 * Workers also soft-caps each suite attempt at this budget in Validate and
 * retries once on GNU `timeout` exit 124, or 137 when `--kill-after` must
 * SIGKILL **after** the soft deadline. Exit 137 before the deadline is an
 * early SIGKILL (not retryable). Assertion failures keep their own status
 * and never retry. ADR 0011 isolation is unchanged. On retry, Validate
 * resets the start epoch so the post-suite check measures the successful
 * attempt only (job wall is the 30-minute Workers timeout).
 *
 * `--advisory` reports an overrun as a GitHub warning annotation and exits 0.
 * Validate passes it on non-pull_request events (push to main, manual bench
 * dispatches): the budget is a regression gate for PRs, and a slow cold run on
 * main should not turn main red or block the production deploy that follows
 * Validate.
 *
 * Usage:
 *   node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch 1710000000
 *   node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch 1710000000
 *   node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch 1710000000 --advisory
 */
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

const unitJobBudgets = {
	node: {
		leg: 'node',
		jobName: '🧪 Node',
		maxSeconds: 720,
	},
	workers: {
		leg: 'workers',
		jobName: '☁️ Workers',
		maxSeconds: 720,
	},
} as const

export type UnitJobLeg = keyof typeof unitJobBudgets

export function getUnitJobMaxSeconds(leg: UnitJobLeg) {
	return unitJobBudgets[leg].maxSeconds
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

export type UnitJobBudgetResult = {
	ok: boolean
	leg: UnitJobLeg
	jobName: string
	elapsedSeconds: number
	maxSeconds: number
	summary: string
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
	const ok = elapsedSeconds <= budget.maxSeconds
	const summary = ok
		? `${budget.jobName} finished in ${elapsedSeconds}s (budget ${budget.maxSeconds}s).`
		: `${budget.jobName} took ${elapsedSeconds}s; budget is ${budget.maxSeconds}s. Speed up the suite - do not delete or skip tests to game the budget.`
	return {
		ok,
		leg: input.leg,
		jobName: budget.jobName,
		elapsedSeconds,
		maxSeconds: budget.maxSeconds,
		summary,
	}
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
	if (result.ok) {
		console.log(result.summary)
		process.exitCode = 0
		return
	}
	if (args.includes('--advisory')) {
		console.log(
			`::warning title=${result.jobName} over budget (advisory)::${result.summary}`,
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
