import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
	expect(node).toContain('shard: [1, 2]')
	expect(node).toContain('NODE_TEST_SHARD: ${{ matrix.shard }}/2')
	expect(node).toContain('fail-fast: false')
	expect(node).toContain('enforce-unit-job-budget.ts --leg node')
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
	expect(workflow).toContain("needs.node.result == 'success'")
	expect(workflow).toContain("needs.node.result != 'success'")
})

test.each(['', 'bench / iteration-2 / '])(
	'wall-clock summary includes both Node and both E2E shards: %s',
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
				'☁️ Workers',
				'🔌 MCP',
				'🧰 CLI',
				'🎭 E2E Report',
				...[1, 2].map((i) => `🧪 Node (${i}/2)`),
				...[1, 2].map((i) => `🎭 E2E (${i}/2)`),
			]
			const jobs = names.map((name) => ({
				name: prefix + name,
				conclusion: 'success',
				started_at: '2026-10-23T00:00:00Z',
				completed_at: '2026-10-23T00:00:10Z',
			}))
			if (prefix)
				jobs.push({ ...jobs[0]!, name: 'bench / iteration-1 / 🎭 E2E (1/2)' })
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
			expect(report.jobs).toHaveLength(9)
			expect(report.sum_job_duration_seconds).toBe(90)
			expect(report.jobs.map((job: { job: string }) => job.job).sort()).toEqual(
				names.sort(),
			)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)
