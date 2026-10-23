/**
 * Keep the supported Node and npm ranges honest.
 *
 * `package-lock.json` is written by whatever npm the author ran, and older
 * npm releases read some lockfiles differently. npm 10.x through 11.6.2, for
 * example, re-resolve an unmet optional peer (`@vitest/mocker` wants
 * `msw@^2` while the repo locks `msw@3`) and then `npm ci` fails with
 * `Missing: msw@2.x from lock file` even though the newer npm in CI is happy.
 *
 * Three guards:
 * - Runtime: root `package.json` declares the Node floor in
 *   `devEngines.runtime` (node, `onFail: "error"`) and `engines.node` with the
 *   same range, so npm stops on an older Node (for example Node 22 or 24 ahead
 *   of Node 26 on `PATH`) with `EBADDEVENGINES`. The Node running this check,
 *   `.nvmrc`, and every `actions/setup-node` `node-version` in `.github` must
 *   satisfy that range.
 * - Static: root `package.json` declares the supported npm range in
 *   `devEngines.packageManager` with `onFail: "error"`, so an unsupported npm
 *   stops every `npm ci` / `npm install` / `npm run` with a clear
 *   `EBADDEVENGINES` error instead of a confusing lockfile error. The pinned
 *   `packageManager` version must sit inside that range.
 * - Install (CI, or `--install`): runs `npm ci --dry-run` with the lowest npm
 *   that range allows against a copy of the manifests and lockfile, so a
 *   lockfile only a newer npm can install fails here instead of in a fresh
 *   agent session.
 *
 * Usage: node tools/check-npm-install-floor.ts [--install]
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'

type RootPackageJson = {
	packageManager?: unknown
	workspaces?: unknown
	engines?: {
		node?: unknown
	}
	devEngines?: {
		runtime?: unknown
		packageManager?: unknown
	}
}

type PackageLock = {
	packages?: Record<string, unknown>
}

export type NpmFloor = {
	/** `devEngines.packageManager.version`, for example `>=11.11.1`. */
	range: string
	/** Lowest npm version the range allows. */
	floor: string
	/** Version from `packageManager` (`npm@<version>`). */
	pinned: string
}

export type NpmFloorResult =
	| { ok: true; npmFloor: NpmFloor }
	| { ok: false; errors: Array<string> }

const fixHint =
	'Declare it in root package.json as "devEngines": { "packageManager": { "name": "npm", "version": ">=<floor>", "onFail": "error" } }.'

export type NodeFloorInput = {
	/** `process.version` of the Node running the check. */
	currentNode: string
	/** Contents of `.nvmrc`, or `null` when the file is absent. */
	nvmrc: string | null
	/** `node-version` values from `actions/setup-node` steps in `.github`. */
	setupNodeVersions: Array<{ file: string; version: string }>
}

export type NodeFloorResult =
	| { ok: true; range: string }
	| { ok: false; errors: Array<string> }

const runtimeFixHint =
	'Declare it in root package.json as "devEngines": { "runtime": { "name": "node", "version": ">=<floor>", "onFail": "error" } }.'

const nodePathHint =
	'Put Node 26 first on PATH (for nvm: `nvm install 26 && nvm use 26`, or `export PATH="$NVM_DIR/versions/node/$(nvm version 26)/bin:$PATH"`) and rerun.'

function satisfiesNodeRange(version: string, range: string) {
	const coerced = semver.coerce(version.trim())
	return coerced ? semver.satisfies(coerced, range) : false
}

export function readNodeFloor(
	pkg: RootPackageJson,
	input: NodeFloorInput,
): NodeFloorResult {
	const errors: Array<string> = []
	const declared = pkg.devEngines?.runtime
	let range: string | undefined
	if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
		errors.push(
			`devEngines.runtime is missing or not a single object. ${runtimeFixHint}`,
		)
	} else {
		const entry = declared as Record<string, unknown>
		if (entry.name !== 'node') {
			errors.push(
				`devEngines.runtime.name must be "node" (found ${JSON.stringify(entry.name)}).`,
			)
		}
		if (entry.onFail !== 'error') {
			errors.push(
				`devEngines.runtime.onFail must be "error" so an unsupported Node stops before it runs repo scripts (found ${JSON.stringify(entry.onFail)}).`,
			)
		}
		if (
			typeof entry.version !== 'string' ||
			!semver.validRange(entry.version) ||
			!semver.minVersion(entry.version)
		) {
			errors.push(
				`devEngines.runtime.version must be a semver range with a minimum (found ${JSON.stringify(entry.version)}).`,
			)
		} else {
			range = entry.version
		}
	}

	if (range && pkg.engines?.node !== range) {
		errors.push(
			`engines.node must match devEngines.runtime.version ${range} (found ${JSON.stringify(pkg.engines?.node)}). Move them together.`,
		)
	}
	if (!range) return { ok: false, errors }

	if (!satisfiesNodeRange(input.currentNode, range)) {
		errors.push(
			`This check ran on Node ${input.currentNode}, outside devEngines.runtime.version ${range}. ${nodePathHint}`,
		)
	}
	if (input.nvmrc !== null && !satisfiesNodeRange(input.nvmrc, range)) {
		errors.push(
			`.nvmrc (${JSON.stringify(input.nvmrc.trim())}) is outside devEngines.runtime.version ${range}.`,
		)
	}
	for (const { file, version } of input.setupNodeVersions) {
		if (!satisfiesNodeRange(version, range)) {
			errors.push(
				`${file} sets up Node ${version}, outside devEngines.runtime.version ${range}.`,
			)
		}
	}

	return errors.length > 0 ? { ok: false, errors } : { ok: true, range }
}

/**
 * `node-version:` values in workflow and composite action YAML. Expressions
 * (`${{ ... }}`) are skipped since they are only known at run time.
 */
export function setupNodeVersionsIn(file: string, yaml: string) {
	const versions: Array<{ file: string; version: string }> = []
	for (const match of yaml.matchAll(
		/^\s*node-version:\s*['"]?([^'"\s#]+)['"]?/gm,
	)) {
		const version = match[1]
		if (!version || version.startsWith('${{')) continue
		versions.push({ file, version })
	}
	return versions
}

function listYamlFiles(dir: string): Array<string> {
	if (!existsSync(dir)) return []
	const files: Array<string> = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name)
		if (entry.isDirectory()) files.push(...listYamlFiles(entryPath))
		else if (/\.ya?ml$/.test(entry.name)) files.push(entryPath)
	}
	return files.toSorted()
}

function readNodeFloorInput(repoRoot: string): NodeFloorInput {
	const nvmrcPath = path.join(repoRoot, '.nvmrc')
	return {
		currentNode: process.version,
		nvmrc: existsSync(nvmrcPath) ? readFileSync(nvmrcPath, 'utf8') : null,
		setupNodeVersions: listYamlFiles(path.join(repoRoot, '.github')).flatMap(
			(file) =>
				setupNodeVersionsIn(
					path.relative(repoRoot, file).split(path.sep).join('/'),
					readFileSync(file, 'utf8'),
				),
		),
	}
}

export function readNpmFloor(pkg: RootPackageJson): NpmFloorResult {
	const errors: Array<string> = []
	const declared = pkg.devEngines?.packageManager
	let range: string | undefined
	if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
		errors.push(
			`devEngines.packageManager is missing or not a single object. ${fixHint}`,
		)
	} else {
		const entry = declared as Record<string, unknown>
		if (entry.name !== 'npm') {
			errors.push(
				`devEngines.packageManager.name must be "npm" (found ${JSON.stringify(entry.name)}).`,
			)
		}
		if (entry.onFail !== 'error') {
			errors.push(
				`devEngines.packageManager.onFail must be "error" so an unsupported npm stops before it misreads package-lock.json (found ${JSON.stringify(entry.onFail)}).`,
			)
		}
		if (
			typeof entry.version !== 'string' ||
			!semver.validRange(entry.version)
		) {
			errors.push(
				`devEngines.packageManager.version must be a semver range (found ${JSON.stringify(entry.version)}).`,
			)
		} else {
			range = entry.version
		}
	}

	const pinnedMatch =
		typeof pkg.packageManager === 'string'
			? /^npm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)
			: null
	const pinned = pinnedMatch?.[1]
	if (!pinned) {
		errors.push(
			`packageManager must pin an exact npm version like "npm@11.11.1" (found ${JSON.stringify(pkg.packageManager)}).`,
		)
	}

	const floor = range ? semver.minVersion(range)?.version : undefined
	if (range && !floor) {
		errors.push(`devEngines.packageManager.version ${range} has no minimum.`)
	}
	if (range && pinned && !semver.satisfies(pinned, range)) {
		errors.push(
			`packageManager npm@${pinned} is outside devEngines.packageManager.version ${range}. Move them together.`,
		)
	}

	if (errors.length > 0 || !range || !floor || !pinned) {
		return { ok: false, errors }
	}
	return { ok: true, npmFloor: { range, floor, pinned } }
}

/**
 * Workspace directories recorded in the lockfile (`packages/cli`, and so on).
 * `npm ci` needs each of their `package.json` files next to the lockfile.
 */
export function lockfileWorkspacePaths(lock: PackageLock): Array<string> {
	return Object.keys(lock.packages ?? {})
		.filter(
			(packagePath) =>
				packagePath !== '' && !packagePath.split('/').includes('node_modules'),
		)
		.toSorted()
}

/**
 * Workspace directories declared in root `package.json` `workspaces`. Supports
 * literal paths and a trailing `/*` (one directory level), which is every form
 * this repo uses. A workspace the lockfile does not list yet still gets staged,
 * so the floor npm sees the same tree the author's npm saw.
 */
export function declaredWorkspacePaths(
	pkg: RootPackageJson,
	listDirectories: (relativeDir: string) => Array<string>,
): Array<string> {
	const entries = Array.isArray(pkg.workspaces)
		? pkg.workspaces.filter(
				(entry): entry is string => typeof entry === 'string',
			)
		: []
	const paths = new Set<string>()
	for (const entry of entries) {
		const normalized = entry.replace(/^\.\//, '').replace(/\/+$/, '')
		if (normalized.endsWith('/*')) {
			const parent = normalized.slice(0, -2)
			for (const child of listDirectories(parent)) {
				paths.add(`${parent}/${child}`)
			}
		} else if (normalized) {
			paths.add(normalized)
		}
	}
	return [...paths].toSorted()
}

function listDirectoriesUnder(repoRoot: string) {
	return (relativeDir: string) => {
		try {
			return readdirSync(path.join(repoRoot, relativeDir), {
				withFileTypes: true,
			})
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
		} catch {
			return []
		}
	}
}

export function floorInstallArgs(floor: string, npmArgs: Array<string>) {
	return ['exec', '--yes', `--package=npm@${floor}`, '--', 'npm', ...npmArgs]
}

export const floorCiArgs = [
	'ci',
	'--dry-run',
	'--ignore-scripts',
	'--no-audit',
	'--no-fund',
]

export function formatFloorInstallFailure(input: {
	floor: string
	range: string
	output: string
}): string {
	const missing = input.output
		.split('\n')
		.map((line) => line.replace(/^npm error\s*/, '').trim())
		.filter(
			(line) => line.startsWith('Missing:') || line.startsWith('Invalid:'),
		)
		.slice(0, 10)
	const detail =
		missing.length > 0
			? `\n${missing.map((line) => `  ${line}`).join('\n')}`
			: `\n${input.output.trim().split('\n').slice(-15).join('\n')}`
	return `npm ci fails with npm ${input.floor}, the lowest npm devEngines.packageManager.version (${input.range}) allows:${detail}\nThe lockfile only installs on a newer npm. Raise devEngines.packageManager.version (and packageManager if it falls below) to the oldest npm that installs it, or change the dependency so older npm accepts the lockfile.`
}

async function stageManifests(repoRoot: string, stageDir: string) {
	const lockText = await readFile(
		path.join(repoRoot, 'package-lock.json'),
		'utf8',
	)
	const lock = JSON.parse(lockText) as PackageLock
	const pkg = JSON.parse(
		await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
	) as RootPackageJson
	const workspacePaths = new Set([
		...lockfileWorkspacePaths(lock),
		...declaredWorkspacePaths(pkg, listDirectoriesUnder(repoRoot)),
	])
	await copyFile(
		path.join(repoRoot, 'package.json'),
		path.join(stageDir, 'package.json'),
	)
	await copyFile(
		path.join(repoRoot, 'package-lock.json'),
		path.join(stageDir, 'package-lock.json'),
	)
	if (existsSync(path.join(repoRoot, '.npmrc'))) {
		await copyFile(path.join(repoRoot, '.npmrc'), path.join(stageDir, '.npmrc'))
	}
	for (const workspacePath of [...workspacePaths].toSorted()) {
		const source = path.join(repoRoot, workspacePath, 'package.json')
		if (!existsSync(source)) continue
		await mkdir(path.join(stageDir, workspacePath), { recursive: true })
		await copyFile(source, path.join(stageDir, workspacePath, 'package.json'))
	}
}

function runNpm(args: Array<string>, cwd: string) {
	const result = spawnSync(resolveNpmCommand(), args, {
		cwd,
		// Node refuses to spawn `npm.cmd` without a shell on Windows. The args
		// are fixed flags plus a semver version, so the shell sees no user input.
		shell: process.platform === 'win32',
		encoding: 'utf8',
		env: { ...process.env, npm_config_update_notifier: 'false' },
		timeout: 5 * 60_000,
		maxBuffer: 64 * 1024 * 1024,
	})
	return {
		status: result.status ?? 1,
		output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? `\n${result.error.message}` : ''}`,
	}
}

export async function checkFloorInstall(
	npmFloor: NpmFloor,
	repoRoot: string = process.cwd(),
): Promise<Array<string>> {
	const stageDir = await mkdtemp(path.join(tmpdir(), 'kody-npm-floor-'))
	try {
		await stageManifests(repoRoot, stageDir)
		const version = runNpm(
			floorInstallArgs(npmFloor.floor, ['--version']),
			stageDir,
		)
		const reported = version.output.trim().split('\n').at(-1)?.trim()
		if (version.status !== 0 || reported !== npmFloor.floor) {
			return [
				`Could not run npm ${npmFloor.floor} through npm exec (got ${JSON.stringify(reported)}, exit ${String(version.status)}). A noexec npm cache or no registry access can cause this.`,
			]
		}
		const ci = runNpm(floorInstallArgs(npmFloor.floor, floorCiArgs), stageDir)
		if (ci.status !== 0) {
			return [
				formatFloorInstallFailure({
					floor: npmFloor.floor,
					range: npmFloor.range,
					output: ci.output,
				}),
			]
		}
		return []
	} finally {
		await rm(stageDir, { recursive: true, force: true })
	}
}

async function main() {
	const pkg = JSON.parse(
		await readFile('package.json', 'utf8'),
	) as RootPackageJson
	const nodeResult = readNodeFloor(pkg, readNodeFloorInput(process.cwd()))
	const result = readNpmFloor(pkg)
	const staticErrors = [
		...(nodeResult.ok ? [] : nodeResult.errors),
		...(result.ok ? [] : result.errors),
	]
	if (staticErrors.length > 0 || !nodeResult.ok || !result.ok) {
		for (const error of staticErrors) console.error(error)
		process.exitCode = 1
		return
	}
	const { npmFloor } = result
	console.log(
		`node-floor: devEngines node ${nodeResult.range} (running ${process.version}; .nvmrc and setup-node agree).`,
	)
	const runInstall =
		process.argv.includes('--install') || Boolean(process.env.CI)
	if (!runInstall) {
		console.log(
			`npm-floor: devEngines npm ${npmFloor.range}, pinned npm@${npmFloor.pinned}. Skipped the npm ${npmFloor.floor} install check (runs in CI; pass --install to run it here).`,
		)
		return
	}
	const errors = await checkFloorInstall(npmFloor)
	if (errors.length > 0) {
		for (const error of errors) console.error(error)
		process.exitCode = 1
		return
	}
	console.log(`npm-floor: npm ${npmFloor.floor} installs package-lock.json.`)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
