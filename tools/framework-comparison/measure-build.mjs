#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	readFileSync,
	readdirSync,
	statSync,
	mkdirSync,
	writeFileSync,
} from 'node:fs'
import { resolve, relative, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { platform, arch, cpus } from 'node:os'

const [
	rootArg,
	label,
	outputArg,
	countArg = '3',
	script = 'build',
	dist = 'dist',
] = process.argv.slice(2)
if (!rootArg || !label || !outputArg)
	throw new Error(
		'Usage: node measure-build.mjs ROOT LABEL OUTPUT_DIRECTORY [RUNS] [BUILD_SCRIPT] [DIST_DIRECTORY]',
	)
const root = resolve(rootArg)
const output = resolve(outputArg)
const count = Number(countArg)
if (!Number.isInteger(count) || count < 1)
	throw new Error('RUNS must be a positive integer')
mkdirSync(output, { recursive: true })
const runs = []
for (let index = 0; index < count; index++) {
	const started = performance.now()
	const result = spawnSync('npm', ['run', script], {
		cwd: root,
		encoding: 'utf8',
		maxBuffer: 50_000_000,
		env: { ...process.env, WRANGLER_LOG_PATH: join(output, 'wrangler.log') },
	})
	runs.push({
		run: index + 1,
		elapsedMs: performance.now() - started,
		exitCode: result.status,
		error: result.error?.message ?? null,
	})
	writeFileSync(
		join(output, `${label}-build-${index + 1}.log`),
		`${result.stdout ?? ''}\n${result.stderr ?? ''}`,
	)
	if (result.status !== 0) break
}
function walk(directory) {
	try {
		return readdirSync(directory).flatMap((name) => {
			const file = join(directory, name)
			return statSync(file).isDirectory() ? walk(file) : [file]
		})
	} catch (error) {
		if (error.code === 'ENOENT') return []
		throw error
	}
}
const assets = runs.every((run) => run.exitCode === 0)
	? walk(join(root, dist))
			.filter((file) => /\.(js|css)$/.test(file))
			.map((file) => {
				const content = readFileSync(file)
				return {
					path: relative(root, file),
					bytes: content.length,
					gzipBytes: gzipSync(content).length,
					sha256: createHash('sha256').update(content).digest('hex'),
				}
			})
	: []
const sourceFiles = walk(join(root, 'packages/worker')).filter(
	(file) =>
		/\.[cm]?[jt]sx?$/.test(file) &&
		!file.includes('/node_modules/') &&
		!file.includes('/public/') &&
		!file.includes('/.wrangler/'),
)
const source = sourceFiles.map((file) => ({
	path: relative(root, file),
	lines: readFileSync(file, 'utf8').split('\n').length,
}))
const report = {
	label,
	measuredAt: new Date().toISOString(),
	root,
	buildScript: script,
	distDirectory: dist,
	node: process.version,
	platform: platform(),
	architecture: arch(),
	cpu: cpus()[0]?.model,
	runs,
	assets,
	source,
	caveats: [
		'Builds are sequential warm-cache runs; output is not cleaned between runs.',
		'Asset totals include lazy chunks and server code, and are not page transfer sizes.',
		'Line counts measure volume, not maintainability or correctness.',
		'Concurrent workloads and thermal state affect build timing.',
	],
}
writeFileSync(
	join(output, `${label}.json`),
	JSON.stringify(report, null, 2) + '\n',
)
console.log(
	JSON.stringify({
		label,
		runs,
		assets: assets.length,
		sourceFiles: source.length,
	}),
)
process.exitCode = runs.every((run) => run.exitCode === 0) ? 0 : 1
