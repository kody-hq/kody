#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const [
	directory,
	revisionsFile = new URL('revisions.json', import.meta.url).pathname,
] = process.argv.slice(2)
if (!directory || Number(process.versions.node.split('.')[0]) < 26)
	throw new Error(
		'Usage with Node 26+: prepare-snapshots.mjs NEW_DIRECTORY [REVISIONS_JSON]',
	)
const output = resolve(directory)
if (existsSync(output)) throw new Error('Snapshot directory must be new')
mkdirSync(output, { recursive: true })
const config = JSON.parse(readFileSync(revisionsFile, 'utf8'))
const run = (command, args, cwd = process.cwd(), env = {}) => {
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: 'inherit',
	})
	if (result.status !== 0)
		throw new Error(`${command} failed (${result.status})`)
}
for (const target of config.targets) {
	if (
		!/^[a-z0-9-]+$/.test(target.label) ||
		!/^[a-f0-9]{40}$/.test(target.commit)
	)
		throw new Error('Expected safe label and full commit SHA')
	target.root = join(output, target.label)
	target.origin = `http://127.0.0.1:${target.port}`
	mkdirSync(target.root)
	const archive = join(output, `${target.label}.tar`)
	run('git', ['archive', '--format=tar', `--output=${archive}`, target.commit])
	run('tar', ['-xf', archive, '-C', target.root])
	rmSync(archive)
	target.lockSha256 = createHash('sha256')
		.update(readFileSync(join(target.root, 'package-lock.json')))
		.digest('hex')
	run('npm', ['ci', '--no-audit', '--no-fund'], target.root)
	run(process.execPath, ['tools/prepare-e2e-env.ts'], target.root)
	run(
		process.execPath,
		[
			'--env-file=packages/worker/.env',
			'--input-type=module',
			'-e',
			`
		import {writeLocalOriginDevConfig,collectLocalOriginDevVars} from './tools/local-origin-dev-config.ts';
		await writeLocalOriginDevConfig({originConfigPath:'packages/worker/wrangler.jsonc',envName:'test',vars:collectLocalOriginDevVars(process.env,'${target.port}'),dropAlwaysRemoteBindings:['artifacts']});
	`,
		],
		target.root,
	)
	run(process.execPath, ['tools/apply-local-app-migrations.ts'], target.root, {
		CLOUDFLARE_ENV: 'test',
	})
	run(
		process.execPath,
		['tools/seed-test-data.ts', '--local', '--env', 'test'],
		target.root,
		{ CLOUDFLARE_ENV: 'test' },
	)
	writeFileSync(
		join(output, 'targets.json'),
		JSON.stringify(config, null, 2) + '\n',
	)
}
