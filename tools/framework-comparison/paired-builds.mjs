#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const [baselineRoot, candidateRoot, outputArg, countArg = '5'] =
	process.argv.slice(2)
if (!baselineRoot || !candidateRoot || !outputArg)
	throw new Error(
		'Usage: node paired-builds.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_DIRECTORY [RUNS]',
	)
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1)
	throw new Error('RUNS must be a positive integer')
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const harness = join(
	dirname(fileURLToPath(import.meta.url)),
	'measure-build.mjs',
)
const targets = [
	{
		label: 'remix',
		root: resolve(baselineRoot),
		script: process.env.BASELINE_BUILD_SCRIPT ?? 'build',
		dist: process.env.BASELINE_DIST ?? 'dist',
		config:
			process.env.BASELINE_WRANGLER_CONFIG ??
			'packages/worker/wrangler-local-dev.generated.json',
	},
	{
		label: 'start',
		root: resolve(candidateRoot),
		script: process.env.CANDIDATE_BUILD_SCRIPT ?? 'build',
		dist: process.env.CANDIDATE_DIST ?? 'dist',
		config:
			process.env.CANDIDATE_WRANGLER_CONFIG ??
			'packages/worker/wrangler-local-dev.generated.json',
	},
]
const reports = []
for (let run = 1; run <= count; run++) {
	for (const target of run % 2 ? targets : [...targets].reverse()) {
		const label = `${target.label}-paired-${run}`
		console.log(`${new Date().toISOString()} ${label} starting`)
		const result = spawnSync(
			process.execPath,
			[
				`--env-file=${join(target.root, 'packages/worker/.env')}`,
				harness,
				target.root,
				label,
				output,
				'1',
				target.script,
				target.dist,
			],
			{
				encoding: 'utf8',
				maxBuffer: 30_000_000,
				env: {
					...process.env,
					CLOUDFLARE_ENV: 'test',
					KODY_WRANGLER_CONFIG: target.config,
				},
			},
		)
		writeFileSync(
			join(output, `${label}-harness.log`),
			`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
		)
		if (result.status !== 0)
			throw new Error(`${label} failed; inspect retained logs`)
		reports.push({
			run,
			framework: target.label,
			...JSON.parse(readFileSync(join(output, `${label}.json`), 'utf8')),
		})
		writeFileSync(
			join(output, 'paired-builds.json'),
			JSON.stringify(
				{
					measuredAt: new Date().toISOString(),
					targets,
					reports,
					caveats: [
						'Sequential paired warm-cache production builds, alternating framework order.',
						'Generated local test binding configs affect runtime bindings, not production optimization.',
						'All source and dependency caches were already warm before these runs.',
						'This measures build wall time, not developer productivity or type-check time.',
					],
				},
				null,
				2,
			) + '\n',
		)
		console.log(
			JSON.stringify({
				framework: target.label,
				run,
				build: reports.at(-1).runs[0],
			}),
		)
	}
}
