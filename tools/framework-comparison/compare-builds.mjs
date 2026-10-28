#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpus } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [configFile, outputArg] = process.argv.slice(2)
if (!configFile || !outputArg)
	throw new Error('Usage: compare-builds.mjs CONFIG NEW_OUTPUT_DIRECTORY')
const config = JSON.parse(readFileSync(configFile, 'utf8'))
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
if (!Number.isInteger(config.runs) || config.runs < 2)
	throw new Error('At least two runs required')
mkdirSync(output, { recursive: true })
const hash = (file) =>
	createHash('sha256').update(readFileSync(file)).digest('hex')
const targets = config.targets.map((target) => ({
	...target,
	lockSha256: hash(join(target.root, 'package-lock.json')),
	packageSha256: hash(join(target.root, 'package.json')),
}))
const report = {
	node: process.version,
	cpu: cpus()[0]?.model,
	targets,
	runs: [],
	caveats: [
		'Complete npm build wall time, including source-map verification where that revision runs it.',
		'First round is reported separately. Later rounds rotate target order and retain warm source/dependency caches.',
		'All emitted JS/CSS includes lazy chunks. This is not page transfer or Worker upload size.',
	],
}
const save = () =>
	writeFileSync(
		join(output, 'runs.json'),
		JSON.stringify(report, null, 2) + '\n',
	)
save()
for (let round = 0; round < config.runs; round++) {
	for (let offset = 0; offset < targets.length; offset++) {
		const target = targets[(round + offset) % targets.length]
		const id = `${target.label}-${round + 1}`
		console.log(id)
		const started = performance.now()
		const result = spawnSync('npm', ['run', 'build'], {
			cwd: target.root,
			encoding: 'utf8',
			maxBuffer: 100_000_000,
			env: {
				...process.env,
				CLOUDFLARE_ENV: 'test',
				KODY_WRANGLER_CONFIG:
					'packages/worker/wrangler-local-dev.generated.json',
				WRANGLER_SEND_METRICS: 'false',
			},
		})
		writeFileSync(
			join(output, `${id}.log`),
			`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
		)
		report.runs.push({
			label: target.label,
			round: round + 1,
			elapsedMs: performance.now() - started,
			exitCode: result.status,
			error: result.error?.message ?? null,
		})
		save()
		if (result.status !== 0) throw new Error(`${id} failed, see retained log`)
	}
}
const inventoryConfig = join(output, 'targets.json')
writeFileSync(
	inventoryConfig,
	JSON.stringify(targets.map((target) => ({ ...target, dist: 'dist' }))),
)
const inventory = spawnSync(
	process.execPath,
	[
		new URL('bundle-inventory.mjs', import.meta.url).pathname,
		inventoryConfig,
		join(output, 'inventory'),
	],
	{ stdio: 'inherit' },
)
if (inventory.status !== 0) throw new Error('Inventory failed')
