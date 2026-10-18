import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	evaluateUnitJobBudget,
	getUnitJobMaxSeconds,
	isRetryableUnitJobAttemptExit,
	main,
	unitJobAttemptKillAfterExitCode,
	unitJobAttemptTimeoutExitCode,
} from './enforce-unit-job-budget.ts'

test('unit job budgets fail any overrun of the cold-run caps', () => {
	const previousExitCode = process.exitCode
	const workflow = readFileSync(
		new URL('../../.github/workflows/validate.yml', import.meta.url),
		'utf8',
	)

	expect(getUnitJobMaxSeconds('node')).toBe(720)
	expect(getUnitJobMaxSeconds('workers')).toBe(720)
	expect(isRetryableUnitJobAttemptExit(unitJobAttemptTimeoutExitCode)).toBe(
		true,
	)
	// 137 without timing is not assumed retryable (could be an early SIGKILL).
	expect(isRetryableUnitJobAttemptExit(unitJobAttemptKillAfterExitCode)).toBe(
		false,
	)
	expect(
		isRetryableUnitJobAttemptExit(unitJobAttemptKillAfterExitCode, {
			elapsedSeconds: 720,
			budgetSeconds: 720,
		}),
	).toBe(true)
	expect(
		isRetryableUnitJobAttemptExit(unitJobAttemptKillAfterExitCode, {
			elapsedSeconds: 100,
			budgetSeconds: 720,
		}),
	).toBe(false)
	expect(isRetryableUnitJobAttemptExit(1)).toBe(false)
	expect(isRetryableUnitJobAttemptExit(0)).toBe(false)

	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 720,
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'node',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 721,
		}).ok,
	).toBe(false)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 720,
		}).ok,
	).toBe(true)
	expect(
		evaluateUnitJobBudget({
			leg: 'workers',
			startEpochSeconds: 1_000,
			nowEpochSeconds: 1_000 + 721,
		}).ok,
	).toBe(false)

	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg node --start-epoch',
	)
	expect(workflow).toContain(
		'node tools/ci/enforce-unit-job-budget.ts --leg workers --start-epoch',
	)
	expect(workflow).toContain('UNIT_JOB_START_EPOCH')
	// Workers retries once on soft-budget timeout (exit 124) or kill-after
	// 137 only after the soft deadline; early SIGKILL is not retryable
	// (#3763). Retry status is captured under bash -e via if/else.
	expect(workflow).toContain('attempt_budget_seconds=720')
	expect(workflow).toContain('kill_after_seconds=60')
	expect(workflow).toContain('attempt_started=$(date +%s)')
	expect(workflow).toContain(
		'[ "$status" -eq 137 ] && [ "$attempt_elapsed" -ge "$remaining" ]',
	)
	expect(workflow).toContain(
		'[ "$status" -eq 137 ] && [ "$attempt_elapsed" -ge "$attempt_budget_seconds" ]',
	)
	expect(workflow).toContain('retrying once (#3763)')
	expect(workflow).toContain('npm run test:workers')
	expect(workflow).toContain(
		'if timeout --signal=TERM --kill-after="${kill_after_seconds}s" "${attempt_budget_seconds}s"',
	)
	// ADR 0011: retry must not disable per-file isolation or skip verify.
	const workersUnitStep = workflow.match(
		/- name: ☁️ Workers unit tests\n([\s\S]*?)\n\n\s+- name: ⏱️ Unit job budget/,
	)?.[1]
	expect(workersUnitStep).toBeTruthy()
	expect(workersUnitStep).not.toContain('--no-isolate')
	expect(workersUnitStep).not.toContain('--no-verify')
	expect(workersUnitStep).not.toContain('setupFiles')
	expect(workflow).toMatch(
		/name: ☁️ Workers\n\s+# Room for one ≤720s attempt[\s\S]*?timeout-minutes: 30/,
	)

	process.exitCode = undefined
	main([
		'--leg',
		'node',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 10),
	])
	expect(process.exitCode).toBe(0)

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	main([
		'--leg',
		'workers',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 721),
	])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('☁️ Workers took'),
	)

	consoleError.mockClear()
	process.exitCode = undefined
	main([])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalledWith(
		'Usage: node tools/ci/enforce-unit-job-budget.ts --leg <node|workers> --start-epoch <unix-seconds> [--advisory]',
	)

	process.exitCode = previousExitCode
})

test('the unit job budget is advisory outside pull requests', () => {
	const previousExitCode = process.exitCode
	const workflow = readFileSync(
		new URL('../../.github/workflows/validate.yml', import.meta.url),
		'utf8',
	)
	// Both post-suite budget checks: enforced on PRs, advisory elsewhere.
	const advisoryFlag =
		/"\$UNIT_JOB_START_EPOCH" \$\{\{ github\.event_name != 'pull_request' &&\s+'--advisory' \|\| '' \}\}/g
	expect(workflow.match(advisoryFlag)).toHaveLength(2)

	const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	main([
		'--leg',
		'node',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 729),
		'--advisory',
	])
	expect(process.exitCode).toBe(0)
	expect(consoleError).not.toHaveBeenCalled()
	expect(consoleLog).toHaveBeenCalledWith(
		expect.stringMatching(
			/^::warning title=🧪 Node over budget \(advisory\)::🧪 Node took 7\d\ds; budget is 720s\./,
		),
	)

	process.exitCode = undefined
	main([
		'--leg',
		'node',
		'--start-epoch',
		String(Math.floor(Date.now() / 1000) - 729),
	])
	expect(process.exitCode).toBe(1)

	consoleLog.mockRestore()
	process.exitCode = previousExitCode
})
