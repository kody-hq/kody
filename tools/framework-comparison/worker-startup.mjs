#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	mkdtempSync,
	cpSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
const [baselineRootArg, candidateRootArg, outputArg, countArg = '3'] =
	process.argv.slice(2)
if (!baselineRootArg || !candidateRootArg || !outputArg)
	throw new Error(
		'Usage: node worker-startup.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_DIRECTORY [RUNS]',
	)
const output = resolve(outputArg)
mkdirSync(output, { recursive: true })
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1)
	throw new Error('RUNS must be a positive integer')
const targets = [
	{
		label: 'remix',
		root: resolve(baselineRootArg),
		config: process.env.BASELINE_STARTUP_CONFIG ?? 'dist/ssr/wrangler.json',
	},
	{
		label: 'start',
		root: resolve(candidateRootArg),
		config:
			process.env.CANDIDATE_STARTUP_CONFIG ?? 'dist-start/server/wrangler.json',
	},
]
const results = []
for (const target of targets) {
	const originalConfigPath = resolve(target.root, target.config)
	const snapshot = mkdtempSync(join(tmpdir(), `kody-startup-${target.label}-`))
	cpSync(dirname(dirname(originalConfigPath)), snapshot, { recursive: true })
	const configPath = join(
		snapshot,
		basename(dirname(originalConfigPath)),
		'wrangler.json',
	)
	const cwd = dirname(configPath)
	const wrangler = join(target.root, 'node_modules/wrangler/bin/wrangler.js')
	const config = JSON.parse(readFileSync(configPath, 'utf8'))
	const main = resolve(cwd, config.main)
	const record = {
		label: target.label,
		configPath,
		entryFileBytes: statSync(main).size,
		dryRun: null,
		profiles: [],
	}
	const dry = spawnSync(
		process.execPath,
		[
			wrangler,
			'deploy',
			'--dry-run',
			'--config',
			configPath,
			'--outdir',
			join(snapshot, 'dry-run'),
		],
		{
			cwd,
			encoding: 'utf8',
			maxBuffer: 50_000_000,
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
		},
	)
	const dryOutput = `${dry.stdout ?? ''}\n${dry.stderr ?? ''}`
	writeFileSync(join(output, `${target.label}-dry-run.log`), dryOutput)
	record.dryRun = {
		exitCode: dry.status,
		error: dry.error?.message ?? null,
		uploadSummary: dryOutput.match(/Total Upload:[^\n]+/)?.[0] ?? null,
	}
	for (let run = 1; run <= count; run++) {
		const result = spawnSync(
			process.execPath,
			[
				wrangler,
				'check',
				'startup',
				'--config',
				configPath,
				'--outfile',
				join(output, `${target.label}-${run}.cpuprofile`),
			],
			{
				cwd,
				encoding: 'utf8',
				maxBuffer: 50_000_000,
				env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
			},
		)
		const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
		writeFileSync(join(output, `${target.label}-${run}.log`), log)
		const active =
			/Active:\s*([\d.]+)\s*ms\s*\(including\s*([\d.]+)\s*ms garbage collection\)/i.exec(
				log,
			)
		const idle = /Idle:\s*([\d.]+)\s*ms/i.exec(log)
		record.profiles.push({
			run,
			exitCode: result.status,
			error: result.error?.message ?? null,
			activeMs: active ? Number(active[1]) : null,
			gcMs: active ? Number(active[2]) : null,
			idleMs: idle ? Number(idle[1]) : null,
		})
	}
	results.push(record)
	writeFileSync(
		join(output, 'startup.json'),
		JSON.stringify(
			{
				measuredAt: new Date().toISOString(),
				results,
				caveats: [
					process.env.STARTUP_TARGET === 'production-slim'
						? 'Checks the actual slim production entry with production bindings, without deploying.'
						: 'Checks optimized local test-binding full origin worker artifacts, not the generated slim production deployment entry.',
					'No deployment performed; deploy --dry-run and check startup only.',
					'Profiles are grouped baseline then candidate; ordering and thermal drift are not controlled.',
					'Local startup profiles do not establish deployed global latency or Cloudflare production binding correctness.',
					'Entry file bytes exclude deferred modules; dry-run upload summaries report total upload.',
					process.env.STARTUP_TARGET === 'production-slim'
						? 'Repository production origin budget: 280ms active startup and 7,750,000 entry bytes.'
						: 'The repository production origin budget is 280ms active startup and 7,750,000 entry bytes, but these full local entries are a different build target and do not replace that production gate.',
				],
			},
			null,
			2,
		) + '\n',
	)
	console.log(JSON.stringify(record))
}
process.exitCode = results.some(
	(result) =>
		result.dryRun.exitCode !== 0 ||
		result.profiles.some(
			(profile) => profile.exitCode !== 0 || profile.activeMs === null,
		),
)
	? 1
	: 0
