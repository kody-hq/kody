import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { cliConfigDir } from '../store.js'

/**
 * Daemon auto-update: every few hours (and on start) the daemon asks npm for
 * the newest @kodycodes/cli, installs a verified copy into a Kody-managed
 * store, and relaunches onto it once runs in flight are done. The store is
 * shared by every daemon on this machine (services, terminals, the desktop
 * app), so they all converge on the same version.
 */

export const packageName = '@kodycodes/cli'
export const registryUrl = 'https://registry.npmjs.org'
/** A daemon exits with this to ask its supervisor to relaunch it (newer CLI). */
export const relaunchExitCode = 75
/**
 * A supervised daemon exits with this when it refused to start for a reason
 * unrelated to its version (runner lock held, Kody unreachable at start), so
 * the supervisor does not count it against that version.
 */
export const startupRefusedExitCode = 76
/** Set on a daemon started by a supervisor; it exits instead of supervising. */
export const supervisedEnvVar = 'KODY_DAEMON_SUPERVISED'
/** `0`, `off`, or `false` turns auto-update off regardless of the policy file. */
export const autoUpdateEnvVar = 'KODY_DAEMON_AUTO_UPDATE'
export const checkIntervalMs = 4 * 60 * 60_000
export const checkJitterMs = 30 * 60_000
/** A newer version waits at most this long for runs and background commands. */
export const maxIdleWaitMs = 24 * 60 * 60_000
const maxTarballBytes = 64 * 1024 * 1024
/** A relaunched daemon that exits on its own within this window failed to start. */
export const healthyAfterMs = 60_000

// --- versions -----------------------------------------------------------

const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/

export function parseVersion(value: string) {
	const match = versionPattern.exec(value.trim())
	if (!match) return null
	return {
		parts: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
		prerelease: match[4] ?? null,
	}
}

/** Negative when a < b, positive when a > b, 0 when equal or unparseable. */
export function compareVersions(a: string, b: string) {
	const left = parseVersion(a)
	const right = parseVersion(b)
	if (!left || !right) return 0
	for (let index = 0; index < 3; index++) {
		const diff = left.parts[index]! - right.parts[index]!
		if (diff !== 0) return diff
	}
	if (left.prerelease === right.prerelease) return 0
	if (left.prerelease === null) return 1
	if (right.prerelease === null) return -1
	return left.prerelease < right.prerelease ? -1 : 1
}

export const isNewer = (candidate: string, than: string) =>
	compareVersions(candidate, than) > 0

/** The npm ranges @kodycodes/cli uses for its dependencies: ^, ~, exact, >=, *. */
export function satisfies(version: string, range: string) {
	const parsed = parseVersion(version)
	const trimmed = range.trim()
	if (!parsed) return false
	if (trimmed === '*' || trimmed === '') return true
	const op = /^(\^|~|>=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
		trimmed,
	)
	if (!op) return false
	const base = op[2]!
	const [major, minor] = parseVersion(base)!.parts
	if (compareVersions(version, base) < 0) return false
	if (parsed.prerelease && !base.includes('-')) return false
	if (!op[1]) return compareVersions(version, base) === 0
	if (op[1] === '>=') return true
	if (op[1] === '~')
		return parsed.parts[0] === major && parsed.parts[1] === minor
	if (major !== 0) return parsed.parts[0] === major
	if (minor !== 0) return parsed.parts[0] === 0 && parsed.parts[1] === minor
	return compareVersions(version, base) === 0
}

// --- paths and state ----------------------------------------------------

/** Where verified CLI versions live (data, not config: it is all re-downloadable). */
export function cliStoreDir(
	env: NodeJS.ProcessEnv = process.env,
	home: string = homedir(),
) {
	if (env.KODY_CLI_STORE_DIR) return env.KODY_CLI_STORE_DIR
	if (process.platform === 'linux') {
		return join(
			env.XDG_DATA_HOME || join(home, '.local', 'share'),
			'kody',
			'cli',
		)
	}
	return join(cliConfigDir(home), 'cli')
}

export type CurrentVersion = {
	version: string
	entry: string
	integrity: string
	installedAt: string
}

export type UpdateEvent = {
	at: string
	from: string
	to: string
	outcome: 'installed' | 'relaunched' | 'failed' | 'bad'
	detail?: string
}

export type UpdateState = {
	lastCheckAt?: string
	lastLatest?: string
	lastError?: string | null
	/** Failed installs, by version: retried with backoff. */
	failures?: Record<
		string,
		{ count: number; nextAttemptAt: string; error: string }
	>
	/** Versions that failed to start after a relaunch: never used again. */
	bad?: Array<string>
	history?: Array<UpdateEvent>
}

function readJsonFile<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T
	} catch {
		return null
	}
}

function writeJsonAtomic(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
	renameSync(temp, path)
}

export function readCurrent(store = cliStoreDir()): CurrentVersion | null {
	const current = readJsonFile<CurrentVersion>(join(store, 'current.json'))
	if (
		!current ||
		typeof current.version !== 'string' ||
		typeof current.entry !== 'string' ||
		!parseVersion(current.version) ||
		!isAbsolute(current.entry) ||
		!isWithinDir(current.entry, join(store, 'versions'))
	) {
		return null
	}
	return current
}

export function readUpdateState(store = cliStoreDir()): UpdateState {
	return readJsonFile<UpdateState>(join(store, 'update-state.json')) ?? {}
}

export function updateState(
	store: string,
	change: (state: UpdateState) => UpdateState,
) {
	const next = change(readUpdateState(store))
	writeJsonAtomic(join(store, 'update-state.json'), next)
	return next
}

export function recordEvent(store: string, event: UpdateEvent) {
	updateState(store, (state) => ({
		...state,
		history: [...(state.history ?? []), event].slice(-20),
	}))
}

/**
 * A relaunched version that exited on its own right away: back off from it,
 * and after three such starts never launch it again.
 */
export function recordFailedStart(
	store: string,
	version: string,
	from: string,
	detail: string,
	now = Date.now(),
) {
	return updateState(store, (state) => {
		const count = (state.failures?.[version]?.count ?? 0) + 1
		const bad = count >= 3
		return {
			...state,
			failures: {
				...state.failures,
				[version]: {
					count,
					nextAttemptAt: new Date(now + backoffMs(count)).toISOString(),
					error: detail,
				},
			},
			...(bad
				? { bad: [...new Set([...(state.bad ?? []), version])].slice(-20) }
				: {}),
			history: [
				...(state.history ?? []),
				{
					at: new Date(now).toISOString(),
					from,
					to: version,
					outcome: bad ? ('bad' as const) : ('failed' as const),
					detail,
				},
			].slice(-20),
		}
	})
}

function isWithinDir(child: string, parent: string) {
	const normalized = normalize(child)
	return normalized.startsWith(normalize(parent) + sep)
}

/**
 * The newer verified CLI this daemon should hand off to, or null. Never an
 * older version, a version marked bad, or an entry that no longer exists.
 */
export function newerInstalledVersion(input: {
	selfVersion: string
	store?: string
	now?: number
}) {
	const store = input.store ?? cliStoreDir()
	const current = readCurrent(store)
	if (!current || !isNewer(current.version, input.selfVersion)) return null
	const state = readUpdateState(store)
	if (state.bad?.includes(current.version)) return null
	const failure = state.failures?.[current.version]
	if (
		failure &&
		Date.parse(failure.nextAttemptAt) > (input.now ?? Date.now())
	) {
		return null
	}
	if (!existsSync(current.entry)) return null
	return current
}

// --- local switch -------------------------------------------------------

export type AutoUpdateSetting = {
	enabled: boolean
	source: 'default' | 'policy' | 'env'
	changedAt?: string
}

/** On by default; the local policy file or KODY_DAEMON_AUTO_UPDATE turns it off. */
export function autoUpdateSetting(
	policy: { autoUpdate?: { enabled: boolean; changedAt?: string } } | null,
	env: NodeJS.ProcessEnv = process.env,
): AutoUpdateSetting {
	const forced = env[autoUpdateEnvVar]?.trim().toLowerCase()
	if (forced && ['0', 'off', 'false', 'no'].includes(forced)) {
		return { enabled: false, source: 'env' }
	}
	if (policy?.autoUpdate) {
		return {
			enabled: policy.autoUpdate.enabled,
			source: 'policy',
			...(policy.autoUpdate.changedAt
				? { changedAt: policy.autoUpdate.changedAt }
				: {}),
		}
	}
	return { enabled: true, source: 'default' }
}

// --- registry -----------------------------------------------------------

export type PublishedVersion = {
	version: string
	tarball: string
	integrity: string
}

/** The `latest` dist-tag, checked for a sha512 integrity and an npm-hosted tarball. */
export async function fetchLatestVersion(input: {
	fetchFn?: typeof fetch
	registry?: string
	timeoutMs?: number
}): Promise<PublishedVersion> {
	const registry = (input.registry ?? registryUrl).replace(/\/$/, '')
	const response = await (input.fetchFn ?? fetch)(
		`${registry}/${packageName.replace('/', '%2F')}/latest`,
		{
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
		},
	)
	if (!response.ok) throw new Error(`npm registry answered ${response.status}`)
	const body = (await response.json()) as {
		name?: unknown
		version?: unknown
		dist?: { tarball?: unknown; integrity?: unknown }
	}
	if (body.name !== packageName) throw new Error('npm returned another package')
	if (typeof body.version !== 'string' || !parseVersion(body.version)) {
		throw new Error('npm returned no valid version')
	}
	const integrity = body.dist?.integrity
	const tarball = body.dist?.tarball
	if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
		throw new Error(`npm lists no sha512 integrity for ${body.version}`)
	}
	if (
		typeof tarball !== 'string' ||
		new URL(tarball).origin !== new URL(registry).origin
	) {
		throw new Error(`npm lists an unexpected tarball URL for ${body.version}`)
	}
	return { version: body.version, tarball, integrity }
}

/** Downloads the tarball and checks it against the registry's sha512 integrity. */
export async function downloadVerified(input: {
	published: PublishedVersion
	fetchFn?: typeof fetch
}) {
	const response = await (input.fetchFn ?? fetch)(input.published.tarball, {
		signal: AbortSignal.timeout(5 * 60_000),
	})
	if (!response.ok)
		throw new Error(`tarball download answered ${response.status}`)
	const bytes = Buffer.from(await response.arrayBuffer())
	if (bytes.byteLength > maxTarballBytes)
		throw new Error('tarball is too large')
	const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
	if (actual !== input.published.integrity) {
		throw new Error(
			`integrity mismatch for ${input.published.version}: npm lists ${input.published.integrity}, the download is ${actual}`,
		)
	}
	return bytes
}

// --- tarball ------------------------------------------------------------

/** Extracts an npm tarball's `package/` tree (files and folders only). */
export function extractPackage(gzipped: Buffer, dest: string) {
	const tar = gunzipSync(gzipped)
	let offset = 0
	let longName: string | null = null
	let paxPath: string | null = null
	const text = (start: number, length: number) => {
		const raw = tar.subarray(start, start + length)
		const end = raw.indexOf(0)
		return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
	}
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512)
		if (header.every((byte) => byte === 0)) break
		const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
		const type = String.fromCharCode(header[156]!)
		const prefix = text(offset + 345, 155)
		const name = text(offset, 100)
		const mode = Number.parseInt(text(offset + 100, 8).trim() || '644', 8)
		const dataStart = offset + 512
		const data = tar.subarray(dataStart, dataStart + size)
		offset = dataStart + Math.ceil(size / 512) * 512
		if (type === 'L') {
			longName = data.toString('utf8').replace(/\0+$/, '')
			continue
		}
		if (type === 'x') {
			const match = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
			paxPath = match ? match[1]! : null
			continue
		}
		if (type === 'g') continue
		const path = paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)
		paxPath = null
		longName = null
		const relative = path.replace(/^package\//, '')
		if (relative === path && path !== 'package') continue
		const parts = relative.split('/').filter(Boolean)
		if (
			parts.some((part) => part === '..' || part === '.') ||
			isAbsolute(relative)
		) {
			throw new Error(`tarball has an unsafe path: ${path}`)
		}
		if (parts.length === 0) continue
		const target = join(dest, ...parts)
		if (type === '5') {
			mkdirSync(target, { recursive: true })
		} else if (type === '0' || type === '\0' || type === '7') {
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, data, { mode: mode & 0o111 ? 0o755 : 0o644 })
		}
		// Links and devices are never part of a CLI package: skip them.
	}
}

// --- install ------------------------------------------------------------

type PackageJson = {
	name?: string
	version?: string
	dependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
}

/** The installed @kodycodes/cli package folder that `entry` belongs to. */
export function packageRootOf(entry: string) {
	let dir = dirname(entry)
	while (dir !== dirname(dir)) {
		const pkg = readJsonFile<PackageJson>(join(dir, 'package.json'))
		if (pkg?.name === packageName) return dir
		dir = dirname(dir)
	}
	return null
}

/**
 * Copies the new version's dependencies from the running install when the
 * versions still satisfy its ranges (they only ship native code and rarely
 * change). Throws when they do not, so the caller falls back to npm.
 */
export function linkDependenciesFrom(input: {
	runningPackageRoot: string
	newPackage: PackageJson
	nodeModules: string
}) {
	const copied = new Map<string, string>()
	const visit = (
		name: string,
		range: string,
		fromDir: string,
		optional: boolean,
	) => {
		let pkgPath: string
		try {
			pkgPath = createRequire(join(fromDir, 'package.json')).resolve(
				`${name}/package.json`,
			)
		} catch {
			if (optional) return
			throw new Error(`dependency ${name} is not installed next to this CLI`)
		}
		const pkg = readJsonFile<PackageJson>(pkgPath)
		const version = pkg?.version ?? ''
		if (!satisfies(version, range)) {
			if (optional) return
			throw new Error(`dependency ${name}@${version} does not satisfy ${range}`)
		}
		const already = copied.get(name)
		if (already !== undefined) {
			if (already !== version)
				throw new Error(`two versions of ${name} are needed`)
			return
		}
		copied.set(name, version)
		const source = dirname(pkgPath)
		cpSync(source, join(input.nodeModules, name), {
			recursive: true,
			dereference: true,
			filter: (path) =>
				!path.slice(source.length).split(/[\\/]/).includes('node_modules'),
		})
		for (const [dep, depRange] of Object.entries(pkg?.dependencies ?? {})) {
			visit(dep, depRange, source, false)
		}
		for (const [dep, depRange] of Object.entries(
			pkg?.optionalDependencies ?? {},
		)) {
			visit(dep, depRange, source, true)
		}
	}
	for (const [name, range] of Object.entries(
		input.newPackage.dependencies ?? {},
	)) {
		visit(name, range, input.runningPackageRoot, false)
	}
}

/** npm next to node, on PATH, or in the usual install folders. */
export function findNpm(env: NodeJS.ProcessEnv = process.env) {
	const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
	const dirs = [
		...(process.versions.electron ? [] : [dirname(process.execPath)]),
		...(env.PATH ?? '').split(delimiter),
		'/opt/homebrew/bin',
		'/usr/local/bin',
		'/usr/bin',
	].filter(Boolean)
	for (const dir of dirs) {
		const candidate = join(dir, bin)
		if (existsSync(candidate)) return candidate
	}
	return null
}

type StepResult = { ok: boolean; output: string }

export type InstallDeps = {
	/** Runs `<cli entry> version` and returns stdout; overridable in tests. */
	smokeTest?: (entry: string) => StepResult | Promise<StepResult>
	/** Installs a tarball's dependencies with npm into `prefix`. */
	npmInstall?: (input: {
		prefix: string
		tarballPath: string
	}) => StepResult | Promise<StepResult>
	runningEntry?: string
}

/** Async so a long npm install never blocks the live daemon's event loop. */
function runStep(
	command: string,
	args: Array<string>,
	options: { timeoutMs: number; env?: NodeJS.ProcessEnv; shell?: boolean },
) {
	return new Promise<{ code: number | null; output: string }>((resolve) => {
		let output = ''
		let settled = false
		const finish = (code: number | null, extra = '') => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve({ code, output: `${output}${extra}` })
		}
		const child = spawn(command, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			...(options.env ? { env: options.env } : {}),
			...(options.shell ? { shell: true } : {}),
		})
		const append = (chunk: Buffer) => {
			output = `${output}${chunk.toString('utf8')}`.slice(-8000)
		}
		child.stdout?.on('data', append)
		child.stderr?.on('data', append)
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			finish(null, `\ntimed out after ${Math.round(options.timeoutMs / 1000)}s`)
		}, options.timeoutMs)
		timer.unref?.()
		child.once('error', (error) => finish(null, error.message))
		child.once('close', (code) => finish(code))
	})
}

async function defaultSmokeTest(entry: string) {
	const result = await runStep(process.execPath, [entry, 'version'], {
		timeoutMs: 60_000,
		env: {
			...process.env,
			KODY_SKIP_SKILL_REFRESH: '1',
			KODY_SKIP_GIT_HELPER_REFRESH: '1',
		},
	})
	return { ok: result.code === 0, output: result.output }
}

async function defaultNpmInstall(input: {
	prefix: string
	tarballPath: string
}) {
	const npm = findNpm()
	if (!npm) {
		return {
			ok: false,
			output: 'npm was not found to install its dependencies',
		}
	}
	const result = await runStep(
		npm,
		[
			'install',
			'--prefix',
			input.prefix,
			'--no-save',
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
			'--omit=dev',
			input.tarballPath,
		],
		{ timeoutMs: 10 * 60_000, shell: process.platform === 'win32' },
	)
	return { ok: result.code === 0, output: result.output.slice(-2000) }
}

/**
 * Installs a verified tarball as `<store>/versions/<version>`, proves it
 * starts (`kody version`), then points current.json at it. Nothing changes
 * for the running daemon until it relaunches, so any failure keeps it as is.
 */
export async function installVersion(input: {
	store: string
	published: PublishedVersion
	tarball: Buffer
	deps?: InstallDeps
}): Promise<CurrentVersion> {
	const { store, published } = input
	const versionsDir = join(store, 'versions')
	const final = join(versionsDir, published.version)
	const entryIn = (root: string) =>
		join(root, 'node_modules', ...packageName.split('/'), 'dist', 'bin.js')
	const smoke = input.deps?.smokeTest ?? defaultSmokeTest
	const proven = async (root: string) => {
		const result = await smoke(entryIn(root))
		if (
			!result.ok ||
			result.output.trim().split('\n').pop()?.trim() !== published.version
		) {
			throw new Error(
				`kody ${published.version} did not start (kody version printed: ${result.output.trim().slice(-300) || 'nothing'})`,
			)
		}
	}
	if (
		readJsonFile<PackageJson>(
			join(final, 'node_modules', ...packageName.split('/'), 'package.json'),
		)?.version === published.version
	) {
		await proven(final)
	} else {
		mkdirSync(versionsDir, { recursive: true, mode: 0o700 })
		const staging = join(
			versionsDir,
			`.staging-${published.version}-${randomBytes(4).toString('hex')}`,
		)
		try {
			const pkgDir = join(staging, 'node_modules', ...packageName.split('/'))
			mkdirSync(pkgDir, { recursive: true })
			extractPackage(input.tarball, pkgDir)
			const pkg = readJsonFile<PackageJson>(join(pkgDir, 'package.json'))
			if (pkg?.name !== packageName || pkg.version !== published.version) {
				throw new Error(
					`the tarball holds ${pkg?.name ?? '?'}@${pkg?.version ?? '?'}, not ${published.version}`,
				)
			}
			const runningRoot = packageRootOf(
				input.deps?.runningEntry ?? process.argv[1] ?? '',
			)
			let linked = false
			let why = 'the running CLI install was not found'
			if (runningRoot) {
				try {
					linkDependenciesFrom({
						runningPackageRoot: runningRoot,
						newPackage: pkg,
						nodeModules: join(staging, 'node_modules'),
					})
					linked = true
				} catch (error) {
					why = error instanceof Error ? error.message : String(error)
				}
			}
			if (!linked) {
				const tarballPath = join(staging, 'package.tgz')
				writeFileSync(tarballPath, input.tarball)
				rmSync(join(staging, 'node_modules'), { recursive: true, force: true })
				const installed = await (input.deps?.npmInstall ?? defaultNpmInstall)({
					prefix: staging,
					tarballPath,
				})
				rmSync(tarballPath, { force: true })
				if (!installed.ok) {
					throw new Error(
						`could not install its dependencies (${why}; npm: ${installed.output.trim() || 'failed'})`,
					)
				}
			}
			await proven(staging)
			rmSync(final, { recursive: true, force: true })
			renameSync(staging, final)
		} finally {
			rmSync(staging, { recursive: true, force: true })
		}
	}
	const current: CurrentVersion = {
		version: published.version,
		entry: entryIn(final),
		integrity: published.integrity,
		installedAt: new Date().toISOString(),
	}
	const existing = readCurrent(store)
	if (!existing || !isNewer(existing.version, current.version)) {
		writeJsonAtomic(join(store, 'current.json'), current)
	}
	pruneVersions(
		store,
		[current.version, existing?.version].filter(Boolean) as Array<string>,
	)
	return readCurrent(store) ?? current
}

/** Keeps the three newest versions (other daemons may still run one) and anything in `keep`. */
export function pruneVersions(store: string, keep: Array<string>) {
	const versionsDir = join(store, 'versions')
	let names: Array<string>
	try {
		names = readdirSync(versionsDir)
	} catch {
		return
	}
	const versions = names
		.filter((name) => parseVersion(name))
		.sort((a, b) => compareVersions(b, a))
	for (const name of versions.slice(3)) {
		if (keep.includes(name)) continue
		rmSync(join(versionsDir, name), { recursive: true, force: true })
	}
	for (const name of names) {
		if (!name.startsWith('.staging-')) continue
		try {
			if (
				Date.now() - statSync(join(versionsDir, name)).mtimeMs >
				60 * 60_000
			) {
				rmSync(join(versionsDir, name), { recursive: true, force: true })
			}
		} catch {}
	}
}

/** One installer at a time per machine; a lock older than 15 minutes is stale. */
export function withStoreLock<T>(store: string, run: () => Promise<T>) {
	const lock = join(store, '.update.lock')
	mkdirSync(store, { recursive: true, mode: 0o700 })
	try {
		mkdirSync(lock)
	} catch {
		try {
			if (Date.now() - statSync(lock).mtimeMs < 15 * 60_000) return null
			rmSync(lock, { recursive: true, force: true })
			mkdirSync(lock)
		} catch {
			return null
		}
	}
	return run().finally(() => rmSync(lock, { recursive: true, force: true }))
}

export function backoffMs(failures: number) {
	return Math.min(
		24 * 60 * 60_000,
		60 * 60_000 * 2 ** Math.max(0, failures - 1),
	)
}

export type CheckResult =
	| { kind: 'disabled' }
	| { kind: 'up-to-date'; latest: string }
	| { kind: 'busy' }
	| { kind: 'backoff'; version: string; until: string }
	| { kind: 'ready'; current: CurrentVersion }
	| { kind: 'failed'; version: string; error: string }

/**
 * One check: hand off to a newer verified copy someone already installed, or
 * fetch, verify, and install the newest release. Never downgrades.
 */
export async function checkForUpdate(input: {
	selfVersion: string
	enabled: boolean
	store?: string
	fetchFn?: typeof fetch
	registry?: string
	deps?: InstallDeps
	now?: () => number
}): Promise<CheckResult> {
	if (!input.enabled) return { kind: 'disabled' }
	const store = input.store ?? cliStoreDir()
	const now = input.now ?? Date.now
	const installed = newerInstalledVersion({
		selfVersion: input.selfVersion,
		store,
	})
	if (installed) return { kind: 'ready', current: installed }
	let published: PublishedVersion
	try {
		published = await fetchLatestVersion({
			...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			...(input.registry ? { registry: input.registry } : {}),
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		updateState(store, (state) => ({
			...state,
			lastCheckAt: new Date(now()).toISOString(),
			lastError: message,
		}))
		return { kind: 'failed', version: 'latest', error: message }
	}
	updateState(store, (state) => ({
		...state,
		lastCheckAt: new Date(now()).toISOString(),
		lastLatest: published.version,
		lastError: null,
	}))
	if (!isNewer(published.version, input.selfVersion)) {
		return { kind: 'up-to-date', latest: published.version }
	}
	const state = readUpdateState(store)
	if (state.bad?.includes(published.version)) {
		return { kind: 'up-to-date', latest: published.version }
	}
	const failure = state.failures?.[published.version]
	if (failure && Date.parse(failure.nextAttemptAt) > now()) {
		return {
			kind: 'backoff',
			version: published.version,
			until: failure.nextAttemptAt,
		}
	}
	const result = await withStoreLock(store, async (): Promise<CheckResult> => {
		try {
			const tarball = await downloadVerified({
				published,
				...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			})
			const current = await installVersion({
				store,
				published,
				tarball,
				...(input.deps ? { deps: input.deps } : {}),
			})
			updateState(store, (s) => {
				const { [published.version]: _, ...failures } = s.failures ?? {}
				return { ...s, failures }
			})
			recordEvent(store, {
				at: new Date(now()).toISOString(),
				from: input.selfVersion,
				to: published.version,
				outcome: 'installed',
			})
			return { kind: 'ready', current }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const count = (failure?.count ?? 0) + 1
			updateState(store, (s) => ({
				...s,
				lastError: message,
				failures: {
					...s.failures,
					[published.version]: {
						count,
						nextAttemptAt: new Date(now() + backoffMs(count)).toISOString(),
						error: message,
					},
				},
			}))
			recordEvent(store, {
				at: new Date(now()).toISOString(),
				from: input.selfVersion,
				to: published.version,
				outcome: 'failed',
				detail: message.slice(0, 500),
			})
			return { kind: 'failed', version: published.version, error: message }
		}
	})
	return result ?? { kind: 'busy' }
}

/** First check a minute or so after start, then every ~4h with jitter. */
export function nextCheckDelay(first: boolean, random = Math.random) {
	if (first) return 30_000 + Math.floor(random() * 90_000)
	return checkIntervalMs + Math.floor((random() * 2 - 1) * checkJitterMs)
}

// --- supervisor ---------------------------------------------------------

/**
 * Runs newer CLI versions as a child of this daemon process: relaunches on
 * `relaunchExitCode` (a newer version is ready), forwards stop signals, and
 * passes any other exit code through. A version that exits on its own right
 * after a relaunch is marked bad and this (older) daemon takes over again.
 */
export async function superviseNewerVersion(input: {
	first: CurrentVersion
	selfVersion: string
	args: Array<string>
	log: (line: string) => void
	store?: string
	execPath?: string
	env?: NodeJS.ProcessEnv
	spawnFn?: typeof spawn
}): Promise<{ kind: 'exit'; code: number } | { kind: 'fallback' }> {
	const store = input.store ?? cliStoreDir()
	let target: CurrentVersion = input.first
	let previous = input.selfVersion
	const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
	for (;;) {
		input.log(`Auto-update: running kody ${target.version} (from ${previous}).`)
		const startedAt = Date.now()
		const child = (input.spawnFn ?? spawn)(
			input.execPath ?? process.execPath,
			[target.entry, ...input.args],
			{
				stdio: 'inherit',
				env: { ...(input.env ?? process.env), [supervisedEnvVar]: '1' },
			},
		)
		const forward = (signal: NodeJS.Signals) => () => {
			try {
				child.kill(signal)
			} catch {}
		}
		const handlers = signals.map((signal) => [signal, forward(signal)] as const)
		for (const [signal, handler] of handlers) process.on(signal, handler)
		const code = await new Promise<number>((resolve) => {
			child.once('error', (error) => {
				input.log(
					`Auto-update: could not start kody ${target.version}: ${error.message}`,
				)
				resolve(1)
			})
			child.once('exit', (exitCode, signal) =>
				resolve(exitCode ?? (signal ? 128 + 15 : 1)),
			)
		})
		for (const [signal, handler] of handlers) process.off(signal, handler)
		recordEvent(store, {
			at: new Date().toISOString(),
			from: previous,
			to: target.version,
			outcome: 'relaunched',
			detail: `exited ${code}`,
		})
		if (code === relaunchExitCode) {
			const next = newerInstalledVersion({ selfVersion: target.version, store })
			if (next) {
				previous = target.version
				target = next
			}
			continue
		}
		if (code === startupRefusedExitCode) return { kind: 'exit', code: 1 }
		if (code !== 0 && Date.now() - startedAt < healthyAfterMs) {
			const seconds = Math.round((Date.now() - startedAt) / 1000)
			recordFailedStart(
				store,
				target.version,
				previous,
				`exited ${code} after ${seconds}s`,
			)
			input.log(
				`Auto-update: kody ${target.version} exited (${code}) ${seconds}s after starting. Staying on ${input.selfVersion} and retrying it later.`,
			)
			return { kind: 'fallback' }
		}
		return { kind: 'exit', code }
	}
}

// --- daemon scheduler ---------------------------------------------------

export type DaemonUpdater = {
	stop: () => void
	checkNow: () => Promise<CheckResult>
}

/**
 * Checks on start and every ~4h. When a newer version is installed, waits
 * until no runs or background host commands are in flight (at most
 * `maxIdleWaitMs`), then calls `onReady` so the daemon drains and relaunches.
 */
export function startDaemonUpdater(input: {
	selfVersion: string
	setting: () => Promise<AutoUpdateSetting>
	busy: () => { runs: number; background: number }
	log: (line: string) => void
	/** `forced`: the idle deadline passed, so background commands stop. */
	onReady: (current: CurrentVersion, forced: boolean) => void
	store?: string
	fetchFn?: typeof fetch
	deps?: InstallDeps
	idlePollMs?: number
	maxIdleWaitMs?: number
	firstDelayMs?: number
	intervalMs?: number
}): DaemonUpdater {
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let running: Promise<CheckResult> | null = null
	let lastEnabled: boolean | null = null
	let reported = ''
	const schedule = (delay: number) => {
		if (stopped) return
		timer = setTimeout(() => void tick(), delay)
		timer.unref?.()
	}
	const waitForIdle = async (current: CurrentVersion) => {
		const deadline = Date.now() + (input.maxIdleWaitMs ?? maxIdleWaitMs)
		let said = false
		let forced = false
		while (!stopped) {
			const busy = input.busy()
			if (busy.runs === 0 && busy.background === 0) break
			if (Date.now() >= deadline) {
				input.log(
					`Auto-update: still busy after ${Math.round((input.maxIdleWaitMs ?? maxIdleWaitMs) / 3_600_000)}h; updating now. Runs in flight finish first; background commands stop.`,
				)
				forced = true
				break
			}
			if (!said) {
				said = true
				input.log(
					`Auto-update: kody ${current.version} is ready. Waiting for ${busy.runs} run(s) and ${busy.background} background command(s) to finish first.`,
				)
			}
			await new Promise((resolve) => {
				const wait = setTimeout(resolve, input.idlePollMs ?? 15_000)
				wait.unref?.()
			})
		}
		if (stopped) return
		stopped = true
		input.log(
			`Auto-update: updating kody ${input.selfVersion} to ${current.version}. New runs go to the next context in the chain until it is back.`,
		)
		input.onReady(current, forced)
	}
	const check = async () => {
		const setting = await input
			.setting()
			.catch((): AutoUpdateSetting => ({ enabled: true, source: 'default' }))
		if (setting.enabled !== lastEnabled) {
			lastEnabled = setting.enabled
			input.log(
				setting.enabled
					? `Auto-update is on (kody ${input.selfVersion}; checks every ~4h). Turn it off with: kody daemon auto-update off`
					: `Auto-update is off${setting.source === 'env' ? ` (${autoUpdateEnvVar})` : ''}. Turn it on with: kody daemon auto-update on`,
			)
		}
		const result = await checkForUpdate({
			selfVersion: input.selfVersion,
			enabled: setting.enabled,
			...(input.store ? { store: input.store } : {}),
			...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
			...(input.deps ? { deps: input.deps } : {}),
		})
		const line =
			result.kind === 'failed'
				? `Auto-update: could not update to ${result.version}: ${result.error}. Staying on ${input.selfVersion}; retrying later.`
				: result.kind === 'backoff'
					? `Auto-update: ${result.version} failed before; next try after ${result.until}.`
					: ''
		if (line && line !== reported) input.log(line)
		reported = line
		return result
	}
	const tick = async () => {
		if (stopped) return
		running ??= check().finally(() => {
			running = null
		})
		let result: CheckResult
		try {
			result = await running
		} catch (error) {
			input.log(
				`Auto-update: check failed: ${error instanceof Error ? error.message : String(error)}. Staying on ${input.selfVersion}; retrying later.`,
			)
			schedule(input.intervalMs ?? nextCheckDelay(false))
			return
		}
		if (result.kind === 'ready' && !stopped) {
			await waitForIdle(result.current)
			return
		}
		schedule(input.intervalMs ?? nextCheckDelay(false))
	}
	schedule(input.firstDelayMs ?? nextCheckDelay(true))
	return {
		stop: () => {
			stopped = true
			clearTimeout(timer)
		},
		checkNow: async () => {
			running ??= check().finally(() => {
				running = null
			})
			return await running
		},
	}
}
