import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { glob } from 'node:fs/promises'
import { dirname, relative } from 'node:path'
import { performance } from 'node:perf_hooks'

// `npm run effect:check`: the Effect slice is typechecked as its own project
// (packages/worker/tsconfig-effect.json) with the Effect Language Service
// diagnostics as errors. A file that imports `effect` outside that project
// would skip those checks, so it fails here.

const project = 'packages/worker/tsconfig-effect.json'
const effectRoots = [
	'packages/worker/src/effect/',
	'packages/worker/src/app/account-deletion.ts',
	'packages/worker/src/account/deletion-fence.ts',
	'packages/worker/src/orgs/hard-purge.ts',
	'packages/worker/src/orgs/purge.ts',
	'packages/worker/src/account/unverified-account-purge.ts',
	'packages/worker/src/guest/guest-account-purge.ts',
	'packages/worker/src/app/retention.ts',
	'packages/worker/src/scheduled/retention-lanes.ts',
	'packages/worker/src/orgs/soft-delete.ts',
	'packages/worker/src/test-support/effect-bridge.ts',
	'packages/worker/src/test-support/stripe-effect.ts',
]
const effectImport =
	/(?:from|import)\s*\(?\s*['"](?:effect|@effect\/[\w-]+)(?:\/[\w/-]+)?['"]/

const outside: Array<string> = []
for await (const file of glob(
	'packages/*/{src,start,universal,tools}/**/*.{ts,tsx}',
	{
		exclude: (path) => path.includes('node_modules'),
	},
)) {
	const path = relative(process.cwd(), file)
	if (effectRoots.some((root) => path.startsWith(root))) continue
	if (effectImport.test(readFileSync(file, 'utf8'))) outside.push(path)
}
if (outside.length > 0) {
	console.error(
		`effect:check: these files import effect outside ${project}'s include (${effectRoots.join(', ')}):\n${outside.map((path) => `  ${path}`).join('\n')}`,
	)
	process.exit(1)
}

function timed(label: string, command: string, args: Array<string>) {
	const started = performance.now()
	const result = spawnSync(command, args, { encoding: 'utf8' })
	const output = `${result.stdout}${result.stderr}`.trim()
	if (output) console.info(output)
	// Effect diagnostics configured as `error` fail the run; tsc exits 2 on them.
	const seconds = ((performance.now() - started) / 1000).toFixed(1)
	console.info(
		`effect:check: ${label} ${result.status === 0 ? 'passed' : 'failed'} in ${seconds}s`,
	)
	if (result.status !== 0) process.exit(result.status ?? 1)
}

// The Language Service CLI's `diagnostics` command does not run on the repo's
// TypeScript 6, so a private copy of TypeScript is patched with it. The shared
// install stays unpatched: the patch roughly triples tsc time repo-wide.
const patchedTypescript = 'node_modules/.cache/effect-check/typescript'
const installedVersion = JSON.parse(
	readFileSync('node_modules/typescript/package.json', 'utf8'),
).version
const patchedVersion = existsSync(`${patchedTypescript}/package.json`)
	? JSON.parse(readFileSync(`${patchedTypescript}/package.json`, 'utf8'))
			.version
	: null
if (patchedVersion !== installedVersion) {
	rmSync(patchedTypescript, { recursive: true, force: true })
	mkdirSync(dirname(patchedTypescript), { recursive: true })
	cpSync('node_modules/typescript', patchedTypescript, { recursive: true })
	timed('language service patch', process.execPath, [
		'node_modules/@effect/language-service/cli.js',
		'patch',
		'--dir',
		patchedTypescript,
		'--module',
		'tsc',
	])
}

timed('tsc + effect language service', process.execPath, [
	`${patchedTypescript}/bin/tsc`,
	'-p',
	project,
])
