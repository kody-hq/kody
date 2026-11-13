import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const workflow = readFileSync(
	new URL('../../.github/workflows/validate.yml', import.meta.url),
	'utf8',
)

test('CI matrices hash shards, retain crash retry and aggregate every shard at the gate', () => {
	const node = workflow.slice(
		workflow.indexOf('\n  node:'),
		workflow.indexOf('\n  workers:'),
	)
	const e2e = workflow.slice(
		workflow.indexOf('\n  e2e:'),
		workflow.indexOf('\n  e2e_report:'),
	)
	const workers = workflow.slice(
		workflow.indexOf('\n  workers:'),
		workflow.indexOf('\n  mcp:'),
	)
	expect(node).toContain('shard: [1, 2]')
	expect(node).toContain('NODE_TEST_SHARD: ${{ matrix.shard }}/2')
	expect(node).toContain('fail-fast: false')
	expect(node).toContain('enforce-unit-job-budget.ts --leg node')
	expect(workers).toContain('shard: [1, 2]')
	expect(workers).toContain('WORKERS_TEST_SHARD: ${{ matrix.shard }}/2')
	expect(workers).toContain('fail-fast: false')
	expect(workers).toContain('enforce-unit-job-budget.ts --leg workers')
	expect(workers).toContain('run: bash tools/ci/workers-unit-attempt.sh')
	expect(workers).toContain('outcome_1: ${{ steps.attempt.outputs.outcome_1 }}')
	expect(workers).toContain('outcome_2: ${{ steps.attempt.outputs.outcome_2 }}')
	const workersRetry = workflow.slice(
		workflow.indexOf('\n  workers_retry:'),
		workflow.indexOf('\n  mcp:'),
	)
	expect(workersRetry).toContain('shard: [1, 2]')
	expect(workersRetry).toContain("WORKERS_ATTEMPT: '2'")
	expect(workersRetry).toContain('run: bash tools/ci/workers-unit-attempt.sh')
	expect(workersRetry.replace(/\s+/g, ' ')).toContain(
		"needs.workers.outputs.outcome_1 == 'timeout' || needs.workers.outputs.outcome_2 == 'timeout'",
	)
	expect(workersRetry.match(/if: .*env\.RETRY == 'true'/g)).toHaveLength(7)
	expect(e2e).toContain('shard: [1, 2]')
	expect(e2e).toContain('E2E_SHARD: ${{ matrix.shard }}/2')
	expect(e2e).toContain('fail-fast: false')
	expect(e2e).not.toContain('--skipNxCache')
	expect(e2e).not.toContain('--shard=')
	expect(e2e.match(/node tools\/run-nx.ts run worker:test-e2e/g)).toHaveLength(
		2,
	)
	expect(e2e).toContain('retry-classifiers.ts e2e e2e-attempt-1.log')
	expect(e2e).toContain('path: blob-report')
	expect(e2e).toMatch(
		/Upload Playwright blob report[\s\S]*?continue-on-error: true[\s\S]*?timeout-minutes: 2[\s\S]*?path: blob-report/,
	)
	const e2eReport = workflow.slice(
		workflow.indexOf('\n  e2e_report:'),
		workflow.indexOf('\n  host_commands:'),
	)
	expect(e2eReport).toContain(
		'::warning::Playwright blob report download failed (diagnostic only).',
	)
	expect(e2eReport).not.toMatch(
		/gh run download[\s\S]*?echo "\$out" >&2[\s\S]*?exit 1/,
	)
	expect(e2eReport).toMatch(
		/Download blob reports[\s\S]*?continue-on-error: true[\s\S]*?timeout-minutes: 2/,
	)
	expect(e2eReport).toMatch(
		/Upload merged HTML report[\s\S]*?continue-on-error: true[\s\S]*?timeout-minutes: 2[\s\S]*?path: playwright-report/,
	)
	const gate = workflow.slice(workflow.indexOf('\n  validate:'))
	for (const job of [
		'node',
		'workers',
		'workers_retry',
		'host_commands',
		'host_commands_macos',
		'host_commands_macos_fallback',
	]) {
		expect(gate).toContain(`      - ${job}\n`)
	}
	expect(gate).toContain('NEEDS: ${{ toJSON(needs) }}')
	expect(gate).toContain('run: node tools/ci/validate-gate-verdict.ts')
})

test('macOS host commands fall back to the Intel pool only when never assigned', () => {
	const hostCommands = workflow.slice(
		workflow.indexOf('\n  host_commands:'),
		workflow.indexOf('\n  host_commands_macos:'),
	)
	const macos = workflow.slice(
		workflow.indexOf('\n  host_commands_macos:'),
		workflow.indexOf('\n  host_commands_macos_fallback:'),
	)
	const fallback = workflow.slice(
		workflow.indexOf('\n  host_commands_macos_fallback:'),
		workflow.indexOf('\n  cli:'),
	)
	expect(hostCommands).toContain(
		'os: [ubuntu-24.04, windows-latest, windows-11-arm]',
	)
	expect(macos).toContain('runs-on: macos-15\n')
	expect(fallback).toContain('runs-on: macos-15-intel')
	expect(fallback.replace(/\s+/g, ' ')).toContain(
		"needs.host_commands_macos.result == 'abandoned'",
	)
	for (const body of [macos, fallback]) {
		expect(body.replace(/\s+/g, ' ')).toContain(
			"github.ref != 'refs/heads/main'",
		)
	}
	expect(hostCommands).not.toContain("github.ref != 'refs/heads/main'")
	for (const body of [hostCommands, macos, fallback]) {
		expect(body).toContain('uses: ./.github/actions/host-commands')
	}
})

test.each(['', 'bench / iteration-2 / '])(
	'wall-clock summary includes every Node, Workers and E2E shard: %s',
	async (prefix) => {
		const root = await mkdtemp(join(tmpdir(), 'validate-shards-'))
		try {
			await mkdir(join(root, 'validate-timings'))
			const script = workflow
				.match(/          python3 <<'PY'\n([\s\S]*?)\n          PY/)?.[1]
				?.replace(/^          /gm, '')
			expect(script).toBeTruthy()
			const names = [
				'🧹 Static',
				'🔌 MCP',
				'🧰 CLI',
				'🎭 E2E Report',
				...[1, 2].map((i) => `🧪 Node (${i}/2)`),
				...[1, 2].map((i) => `☁️ Workers (${i}/2)`),
				...[1, 2].map((i) => `🎭 E2E (${i}/2)`),
			]
			const jobs = names.map((name) => ({
				name: prefix + name,
				conclusion: 'success',
				started_at: '2026-10-23T00:00:00Z',
				completed_at: '2026-10-23T00:00:10Z',
			}))
			if (prefix) {
				for (const leaf of ['🎭 E2E (1/2)', '☁️ Workers (1/2)']) {
					jobs.push({ ...jobs[0]!, name: `bench / iteration-1 / ${leaf}` })
				}
			}
			const result = spawnSync('python3', ['-c', script!], {
				cwd: root,
				encoding: 'utf8',
				env: {
					...process.env,
					JOBS_JSON: JSON.stringify({ jobs }),
					GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
				},
			})
			expect(result.stderr).toBe('')
			expect(result.status).toBe(0)
			const report = JSON.parse(
				await readFile(join(root, 'validate-timings/timings.json'), 'utf8'),
			)
			expect(report.jobs).toHaveLength(10)
			expect(report.sum_job_duration_seconds).toBe(100)
			expect(report.jobs.map((job: { job: string }) => job.job).sort()).toEqual(
				names.sort(),
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

test.each([0, 2])(
	'benchmark summary records both Workers shards across %i iterations',
	async (iterations) => {
		const root = await mkdtemp(join(tmpdir(), 'validate-bench-shards-'))
		try {
			const bench = readFileSync(
				new URL('../../.github/workflows/validate-bench.yml', import.meta.url),
				'utf8',
			)
			const script = [
				...bench.matchAll(
					/          python3 <<'PY'\n([\s\S]*?)\n          PY/g,
				),
			]
				.map((match) => match[1])
				.find((body) => body?.includes('kody.validate-bench.v1'))
				?.replace(/^          /gm, '')
			expect(script).toBeTruthy()
			await mkdir(join(root, 'bench-timings'))
			for (let i = 0; i < iterations; i += 1) {
				const iterationDir = join(root, 'bench-timings', `iteration-${i}`)
				await mkdir(iterationDir)
				await writeFile(
					join(iterationDir, 'timings.json'),
					JSON.stringify({
						jobs: [1, 2].map((shard) => ({
							job: `☁️ Workers (${shard}/2)`,
							duration_seconds: shard * 10 + i,
						})),
					}),
				)
			}
			const result = spawnSync('python3', ['-c', script!], {
				cwd: root,
				encoding: 'utf8',
				env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, 'summary.md') },
			})
			expect(result.stderr).toBe('')
			expect(result.status).toBe(0)
			const report = JSON.parse(
				await readFile(join(root, 'bench-summary/summary.json'), 'utf8'),
			)
			expect(report.iterations_recorded).toBe(iterations)
			for (const shard of [1, 2]) {
				expect(report.jobs[`☁️ Workers (${shard}/2)`]).toMatchObject({
					values: iterations ? [shard * 10, shard * 10 + 1] : [],
					median: iterations ? shard * 10 + 0.5 : null,
				})
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

test('main reuses a stamped PR tree only by skipping verification jobs', () => {
	const jobs = workflow.slice(workflow.indexOf('\njobs:'))
	const gate = jobs.slice(jobs.indexOf('\n  validate:'))
	const verificationJobs = [
		'static',
		'node',
		'workers',
		'mcp',
		'e2e',
		'host_commands',
		'host_commands_macos',
		'host_commands_macos_fallback',
		'workers_retry',
		'cli',
		'cli_windows',
		'dev_runtime',
	]
	for (const job of verificationJobs) {
		const start = jobs.indexOf(`\n  ${job}:`)
		const body = jobs.slice(start, jobs.indexOf('\n    steps:', start))
		expect(`${job}: ${body}`).toMatch(/needs: (tested_tree|\[tested_tree,)/)
		expect(`${job}: ${body}`).toContain(
			"needs.tested_tree.outputs.skip != 'true'",
		)
	}
	expect(gate).toContain('- tested_tree')
	expect(gate).toContain('node tools/ci/tested-tree.ts stamp')
	expect(gate.replace(/\s+/g, ' ')).toContain(
		'github.event.pull_request.head.repo.full_name == github.repository',
	)
})
