#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
const [runFile] = process.argv.slice(2)
if (!runFile) throw new Error('Usage: node serve-local-production.mjs RUN_JSON')
const run = JSON.parse(readFileSync(runFile, 'utf8'))
const child = spawn(
	process.execPath,
	[
		join(run.root, 'node_modules/wrangler/bin/wrangler.js'),
		'dev',
		...run.configs.flatMap((path) => ['--config', path]),
		'--local',
		'--ip',
		'127.0.0.1',
		'--port',
		String(run.port),
		'--persist-to',
		run.persistTo,
	],
	{ cwd: run.root, env: process.env, stdio: 'inherit' },
)
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, () => child.kill(signal))
child.on('exit', (code) => {
	process.exitCode = code ?? 1
})
