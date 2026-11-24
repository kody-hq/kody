import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, globSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/**
 * Effect Language Service diagnostics for the Effect slices, with every rule
 * configured in packages/worker/tsconfig-effect.json and
 * packages/jobs-worker/tsconfig-effect.json reported as a tsc error.
 *
 * The service's `diagnostics` command does not run on TypeScript 6, so this
 * patches a private copy of `typescript` (never the shared install) and runs
 * its `tsc` on the Effect tsconfig. Any diagnostic it prints, warnings
 * included, fails the check.
 *
 * First it refuses the escape hatches the type checker cannot see in the
 * webhook dispatch queue and jobs watchdog slice: a Promise wrapped without `outbound` (no deadline,
 * no abort), a nested run instead of `runEdge`, wall-clock time instead of
 * `Clock`, `JSON.parse` instead of `Schema`, raw console writes instead of
 * `Effect.log`, and timers instead of `Schedule`. A line that needs one says
 * why in a `// effect-check: allow <reason>` comment just above it.
 */
const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const source = path.dirname(require.resolve('typescript/package.json'))
const copy = path.join(root, 'node_modules/.cache/effect-tsc/typescript')
const version = (dir: string) =>
	JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
const run = (command: string, args: Array<string>) =>
	spawnSync(command, args, { cwd: root, stdio: 'inherit' }).status ?? 1

const sliceFiles = globSync(
	[
		'packages/shared/src/effect/*.ts',
		'packages/worker/src/webhooks/dispatch-queue.ts',
		'packages/jobs-worker/src/watchdog.ts',
	],
	{ cwd: root },
).filter((file) => !file.endsWith('.test.ts'))
const refused: ReadonlyArray<readonly [RegExp, string]> = [
	[
		/\bEffect\.(tryPromise|promise)\(/,
		'wrap Promise APIs with outbound() or the D1 and R2 services',
	],
	[
		/\b(Effect|ManagedRuntime)\.run\w*\(|\.runPromise\w*\(/,
		'leave the slice only through runEdge',
	],
	[/\bDate\.now\(|\bnew Date\(\)/, 'read time from Clock'],
	[/\bJSON\.parse\(/, 'decode with Schema.fromJsonString'],
	[/\bconsole\.\w+\(/, 'log with Effect.log*'],
	[/\bset(Timeout|Interval)\(/, 'wait with Effect.sleep or Schedule'],
]
const findings: Array<string> = []
for (const file of sliceFiles) {
	const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
	lines.forEach((line, index) => {
		if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
		if (/\/\/ effect-check: allow \S/.test(lines[index - 1] ?? '')) return
		for (const [pattern, fix] of refused) {
			if (pattern.test(line)) {
				findings.push(`${file}:${String(index + 1)}: ${fix}: ${line.trim()}`)
			}
		}
	})
}
if (findings.length > 0) {
	console.error(findings.join('\n'))
	process.exit(1)
}

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

let failed = false
for (const project of [
	'packages/worker/tsconfig-effect.json',
	'packages/jobs-worker/tsconfig-effect.json',
]) {
	const tsc = spawnSync(
		process.execPath,
		[
			path.join(copy, 'bin/tsc'),
			'-p',
			project,
			'--noEmit',
			'--pretty',
			'false',
		],
		{ cwd: root, encoding: 'utf8' },
	)
	const output = `${tsc.stdout}${tsc.stderr}`
	process.stdout.write(output)
	if (tsc.status !== 0 || /\bTS\d+:/.test(output)) failed = true
}
process.exit(failed ? 1 : 0)
