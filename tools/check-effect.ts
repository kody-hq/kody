import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Effect Language Service diagnostics for the Effect slices, with every rule
 * configured in packages/worker/tsconfig-effect.json reported as a tsc error.
 *
 * The service's `diagnostics` command does not run on TypeScript 6, so this
 * patches a private copy of `typescript` (never the shared install) and runs
 * its `tsc` on the Effect tsconfig.
 */
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const source = path.dirname(require.resolve('typescript/package.json'))
const copy = path.join(root, 'node_modules/.cache/effect-tsc/typescript')
const version = (dir: string) =>
	JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
const run = (command: string, args: Array<string>) =>
	spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1

if (!existsSync(copy) || version(copy) !== version(source)) {
	rmSync(copy, { recursive: true, force: true })
	cpSync(source, copy, { recursive: true })
	for (const module of ['tsc', 'typescript']) {
		const status = run(
			path.join(root, 'node_modules/.bin/effect-language-service'),
			['patch', '--dir', copy, '--module', module, '--force'],
		)
		if (status !== 0) process.exit(status)
	}
}

process.exit(
	run(process.execPath, [
		path.join(copy, 'bin/tsc'),
		'-p',
		'packages/worker/tsconfig-effect.json',
		'--noEmit',
	]),
)
