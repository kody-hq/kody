/**
 * Keep the supported npm range honest.
 *
 * `package-lock.json` is written by whatever npm the author ran, and older
 * npm releases read some lockfiles differently. npm 10.x through 11.6.2, for
 * example, re-resolve an unmet optional peer (`@vitest/mocker` wants
 * `msw@^2` while the repo locks `msw@3`) and then `npm ci` fails with
 * `Missing: msw@2.x from lock file` even though the newer npm in CI is happy.
 *
 * Two guards:
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
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import semver from 'semver'
import { isExecutedDirectly, resolveNpmCommand } from './node-runtime.ts'

type RootPackageJson = {
	packageManager?: unknown
	devEngines?: {
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
	for (const workspacePath of lockfileWorkspacePaths(lock)) {
		const source = path.join(repoRoot, workspacePath, 'package.json')
		if (!existsSync(source)) continue
		await mkdir(path.join(stageDir, workspacePath), { recursive: true })
		await copyFile(source, path.join(stageDir, workspacePath, 'package.json'))
	}
}

function runNpm(args: Array<string>, cwd: string) {
	const result = spawnSync(resolveNpmCommand(), args, {
		cwd,
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
	const result = readNpmFloor(pkg)
	if (!result.ok) {
		for (const error of result.errors) console.error(error)
		process.exitCode = 1
		return
	}
	const { npmFloor } = result
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
