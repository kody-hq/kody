#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	openSync,
	closeSync,
	readFileSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { artifactFingerprint } from './artifact-fingerprint.mjs'

const [configFile, outputArg, ...checks] = process.argv.slice(2)
if (
	!configFile ||
	!outputArg ||
	!checks.length ||
	checks.some(
		(check) =>
			![
				'browser',
				'private',
				'freshness',
				'lighthouse-targets',
				'release',
			].includes(check),
	)
)
	throw new Error(
		'Usage: run-local.mjs CONFIG NEW_OUTPUT_DIRECTORY browser|private|freshness|lighthouse-targets|release ...',
	)
const config = {
	...JSON.parse(
		readFileSync(new URL('public-scenarios.json', import.meta.url), 'utf8'),
	),
	...JSON.parse(readFileSync(configFile, 'utf8')),
}
config.runs = config.lighthouseRuns ?? 5
const output = resolve(outputArg)
if (existsSync(output)) throw new Error('Output directory must be new')
mkdirSync(output, { recursive: true })
const fingerprints = config.targets.map((target) => ({
	label: target.label,
	before: artifactFingerprint(target.root),
}))
writeFileSync(
	join(output, 'artifact-fingerprints.json'),
	JSON.stringify(fingerprints, null, 2) + '\n',
)
const servers = []
let active
const stop = () => {
	active?.kill('SIGTERM')
	for (const server of servers) server.child.kill('SIGTERM')
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop)
try {
	for (const target of config.targets) {
		const port = new URL(target.origin).port
		const prepared = spawnSync(
			process.execPath,
			[
				new URL('prepare-local-production.mjs', import.meta.url).pathname,
				target.root,
				`dist/${target.serverDirectory ?? (target.label === 'remix' ? 'ssr' : 'server')}/wrangler.json`,
				target.label,
				port,
				...(target.commit ? [target.commit] : []),
			],
			{ encoding: 'utf8' },
		)
		if (prepared.status !== 0) throw new Error(prepared.stderr)
		const runFile = prepared.stdout.trim().split('\n').at(-1)
		const log = openSync(join(output, `${target.label}-server.log`), 'w')
		const child = spawn(
			process.execPath,
			[
				new URL('serve-local-production.mjs', import.meta.url).pathname,
				runFile,
			],
			{ stdio: ['ignore', log, log] },
		)
		closeSync(log)
		servers.push({ child, label: target.label })
		let ready = false
		for (let attempt = 0; attempt < 60; attempt++) {
			if (child.exitCode !== null)
				throw new Error(`${target.label} server exited during startup`)
			try {
				const response = await fetch(target.origin, {
					signal: AbortSignal.timeout(3000),
				})
				if (
					response.status === 200 &&
					(await response.text()).includes('<h1')
				) {
					ready = true
					break
				}
			} catch {}
			await new Promise((resolve) => setTimeout(resolve, 1000))
		}
		if (!ready) throw new Error(`${target.label} production server not ready`)
		if (target.commit) {
			const health = spawnSync(
				process.execPath,
				[
					new URL('../control-kody.ts', import.meta.url).pathname,
					'health',
					'--origin',
					target.origin,
					'--sha',
					target.commit,
				],
				{ encoding: 'utf8' },
			)
			writeFileSync(
				join(output, `${target.label}-health.log`),
				`${health.stdout ?? ''}\n${health.stderr ?? ''}`,
			)
			if (health.status !== 0)
				throw new Error(
					`${target.label} health SHA does not match the source revision`,
				)
		}
		console.log(`${target.label} ready`)
	}
	const localConfig = join(output, 'config.json')
	writeFileSync(localConfig, JSON.stringify(config, null, 2) + '\n')
	for (const check of checks) {
		console.log(`Starting ${check}`)
		const checkConfig =
			check === 'private'
				? {
						...config,
						...JSON.parse(
							readFileSync(
								new URL('private-scenarios.json', import.meta.url),
								'utf8',
							),
						),
					}
				: check === 'freshness'
					? { ...config, rounds: config.freshnessRounds ?? 3 }
					: config
		const checkConfigFile = join(output, `${check}-config.json`)
		writeFileSync(checkConfigFile, JSON.stringify(checkConfig, null, 2) + '\n')
		const log = openSync(join(output, `${check}.log`), 'w')
		active = spawn(
			process.execPath,
			[
				new URL(
					`${check === 'private' ? 'browser' : check}.mjs`,
					import.meta.url,
				).pathname,
				checkConfigFile,
				join(output, check),
			],
			{ stdio: ['ignore', log, log] },
		)
		closeSync(log)
		const monitor = setInterval(() => {
			if (servers.some((server) => server.child.exitCode !== null))
				active?.kill('SIGTERM')
		}, 1000)
		const code = await new Promise((resolve, reject) => {
			active.on('error', reject)
			active.on('exit', resolve)
		})
		clearInterval(monitor)
		if (code !== 0)
			throw new Error(`${check} failed (${code}), inspect retained output`)
		active = undefined
	}
	for (const [index, target] of config.targets.entries()) {
		fingerprints[index].after = artifactFingerprint(target.root)
		if (fingerprints[index].before.sha256 !== fingerprints[index].after.sha256)
			throw new Error(`${target.label} build changed during measurement`)
	}
	writeFileSync(
		join(output, 'artifact-fingerprints.json'),
		JSON.stringify(fingerprints, null, 2) + '\n',
	)
} finally {
	stop()
}
