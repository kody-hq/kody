#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [configFile, outputArg] = process.argv.slice(2)
if (!configFile || !outputArg)
	throw new Error('Usage: startup.mjs TARGETS_JSON NEW_OUTPUT_DIRECTORY')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const profilerRoot = fileURLToPath(new URL('../../', import.meta.url))
const profiler = join(profilerRoot, 'node_modules/wrangler/bin/wrangler.js')
const report = {
	node: process.version,
	profilerVersion: JSON.parse(
		readFileSync(
			join(profilerRoot, 'node_modules/wrangler/package.json'),
			'utf8',
		),
	).version,
	targets: [],
	caveats: [
		'Local module evaluation CPU, not request TTFB, global edge cold starts or an added cost on every request.',
		'Each revision builds its real slim production-worker.ts entry with its own dependencies. A single pinned Wrangler/workerd profiler measures every artifact.',
		'Three sequential samples per revision. No timed browser runs or other builds should overlap profiling.',
	],
}
const save = () =>
	writeFileSync(
		join(output, 'runs.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
for (const target of config.targets) {
	const { parseJsonc } = await import(
		pathToFileURL(join(target.root, 'tools/ci/resource-utils.ts')).href
	)
	const original = parseJsonc(
		readFileSync(join(target.root, 'packages/worker/wrangler.jsonc'), 'utf8'),
	)
	const generated = join(
		target.root,
		'packages/worker/wrangler-performance-startup.generated.json',
	)
	writeFileSync(
		generated,
		JSON.stringify({ ...original, main: './src/production-worker.ts' }) + '\n',
	)
	const built = spawnSync('npm', ['run', 'build'], {
		cwd: target.root,
		encoding: 'utf8',
		maxBuffer: 100_000_000,
		env: {
			...process.env,
			CLOUDFLARE_ENV: 'production',
			KODY_WRANGLER_CONFIG: generated,
			WRANGLER_SEND_METRICS: 'false',
		},
	})
	writeFileSync(
		join(output, `${target.label}-build.log`),
		`${built.stdout ?? ''}\n${built.stderr ?? ''}`,
	)
	rmSync(generated)
	if (built.status !== 0)
		throw new Error(`${target.label} production entry build failed`)
	const snapshot = join(output, target.label)
	cpSync(join(target.root, 'dist'), snapshot, { recursive: true })
	const wranglerConfig = join(
		snapshot,
		target.serverDirectory ?? (target.label === 'remix' ? 'ssr' : 'server'),
		'wrangler.json',
	)
	const row = { label: target.label, commit: target.commit, samples: [] }
	report.targets.push(row)
	for (let index = 0; index < 3; index++) {
		const result = spawnSync(
			process.execPath,
			[profiler, 'check', 'startup', '--config', wranglerConfig],
			{
				cwd: dirname(wranglerConfig),
				encoding: 'utf8',
				maxBuffer: 30_000_000,
				env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
			},
		)
		const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
		writeFileSync(join(output, `${target.label}-${index + 1}.log`), text)
		const active = /Active:\s*([\d.]+)\s*ms/i.exec(text)
		row.samples.push({
			sample: index + 1,
			exitCode: result.status,
			activeMs: active ? Number(active[1]) : null,
			error: result.error?.message ?? null,
		})
		save()
		if (result.status !== 0 || !active)
			throw new Error(
				`${target.label} startup profile failed, inspect retained log`,
			)
	}
	console.log(
		target.label,
		row.samples.map((sample) => sample.activeMs),
	)
}
