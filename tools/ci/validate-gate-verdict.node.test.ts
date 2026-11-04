import { expect, test } from 'vitest'
import {
	classifyValidateNeeds,
	renderVerdict,
	type Needs,
} from './validate-gate-verdict.ts'

const success = { result: 'success', outputs: {} }

function needs(overrides: Needs = {}): Needs {
	return {
		tested_tree: { result: 'success', outputs: { skip: 'false' } },
		static: success,
		node: success,
		workers: {
			result: 'success',
			outputs: { outcome_1: 'pass', outcome_2: 'pass' },
		},
		workers_retry: { result: 'skipped', outputs: {} },
		mcp: success,
		e2e: success,
		e2e_report: success,
		cli: success,
		cli_windows: success,
		host_commands: success,
		host_commands_macos: success,
		host_commands_macos_fallback: { result: 'skipped', outputs: {} },
		...overrides,
	}
}

test('passes when every job succeeds', () => {
	const result = classifyValidateNeeds(needs())
	expect(result.verdict).toBe('pass')
	expect(renderVerdict(result).annotations).toEqual([])
})

test('a never-assigned macos-15 job passes only when the Intel fallback runs and passes', () => {
	const recovered = classifyValidateNeeds(
		needs({
			host_commands_macos: { result: 'abandoned' },
			host_commands_macos_fallback: { result: 'success' },
		}),
	)
	expect(recovered.verdict).toBe('pass')
	expect(renderVerdict(recovered).annotations).toEqual([
		'::notice title=Recovered: host_commands_macos::macos-15 never assigned a runner; passed on macos-15-intel',
	])

	const noRunner = classifyValidateNeeds(
		needs({
			host_commands_macos: { result: 'abandoned' },
			host_commands_macos_fallback: { result: 'abandoned' },
		}),
	)
	expect(noRunner.verdict).toBe('infra')
	expect(renderVerdict(noRunner).annotations[0]).toMatch(
		/^::error title=CI infrastructure, not a code failure: host_commands_macos::/,
	)

	const fallbackFailed = classifyValidateNeeds(
		needs({
			host_commands_macos: { result: 'abandoned' },
			host_commands_macos_fallback: { result: 'failure' },
		}),
	)
	expect(fallbackFailed.verdict).toBe('fail')
})

test('a macOS job that ran and failed or timed out is a failure, not infra', () => {
	for (const result of ['failure', 'cancelled', 'skipped']) {
		expect(
			classifyValidateNeeds(needs({ host_commands_macos: { result } })).verdict,
		).toBe('fail')
	}
})

test('skipped is never a pass outside the reused-tree path', () => {
	expect(
		classifyValidateNeeds(needs({ static: { result: 'skipped' } })).verdict,
	).toBe('fail')
})

test('an abandoned job elsewhere is infra, but a real failure still wins', () => {
	expect(
		classifyValidateNeeds(needs({ host_commands: { result: 'abandoned' } }))
			.verdict,
	).toBe('infra')
	expect(
		classifyValidateNeeds(
			needs({
				host_commands: { result: 'abandoned' },
				cli: { result: 'failure' },
			}),
		).verdict,
	).toBe('fail')
})

test('a Workers shard that hit the budget passes only on its fresh-runner retry', () => {
	const timedOut = {
		result: 'failure',
		outputs: { outcome_1: 'timeout', outcome_2: 'pass' },
	}
	expect(
		classifyValidateNeeds(
			needs({
				workers: timedOut,
				workers_retry: { result: 'success', outputs: { outcome_1: 'pass' } },
			}),
		).verdict,
	).toBe('pass')
	expect(
		classifyValidateNeeds(
			needs({
				workers: timedOut,
				workers_retry: { result: 'failure', outputs: { outcome_1: 'timeout' } },
			}),
		).verdict,
	).toBe('fail')
	expect(
		classifyValidateNeeds(
			needs({
				workers: timedOut,
				workers_retry: { result: 'abandoned', outputs: {} },
			}),
		).verdict,
	).toBe('infra')
})

test('Workers assertion failures never pass through the retry', () => {
	expect(
		classifyValidateNeeds(
			needs({
				workers: {
					result: 'failure',
					outputs: { outcome_1: 'fail', outcome_2: 'pass' },
				},
				workers_retry: { result: 'success', outputs: { outcome_1: 'pass' } },
			}),
		).verdict,
	).toBe('fail')
})

test('fails closed when a Workers shard reports no outcome', () => {
	const result = classifyValidateNeeds(
		needs({ workers: { result: 'success', outputs: { outcome_1: 'pass' } } }),
	)
	expect(result.verdict).toBe('fail')
	expect(result.jobs.find((job) => job.job === 'workers 2/2')?.detail).toBe(
		'no outcome reported (workers=success)',
	)
})
