import {
	lstat,
	mkdir,
	readFile,
	readlink,
	realpath,
	rename,
	writeFile,
} from 'node:fs/promises'
import {
	basename,
	dirname,
	isAbsolute as isRooted,
	join,
	normalize,
	posix,
	win32,
} from 'node:path'
import { homedir } from 'node:os'
import { cliConfigDir } from '../store.js'

export type FsMode = 'ro' | 'rw'
export type FsRule = { path: string; mode: FsMode }
type FsLayer = 'server_grant' | 'local_policy' | 'credential_denylist'
/** Host commands opt-in on this machine (ADR 0093). Absent means off. */
type LocalCommandsPolicy = { enabled: boolean; changedAt?: string }
export type LocalFsPolicy = {
	version: 1
	fs: Array<FsRule>
	commands?: LocalCommandsPolicy
	/** Daemon auto-update on this machine. Absent means on. */
	autoUpdate?: LocalCommandsPolicy
}
type FsMount = { path: string; mode: FsMode }
type FsRefusal = { path: string; layer: FsLayer; reason: string }
/**
 * Host folders one run may touch: the server grant intersected with this
 * machine's local policy, plus the grant roots so refusals can name the layer.
 */
export type EffectiveFs = {
	mounts: Array<FsMount>
	refused: Array<FsRefusal>
	grantRoots: Array<string>
	/** Credential paths runs never touch, even inside a mount. */
	denied: Array<string>
}

export const emptyEffectiveFs: EffectiveFs = {
	mounts: [],
	refused: [],
	grantRoots: [],
	denied: [],
}

/**
 * Credential stores a run never reads or writes through host folders or uses
 * as a command's cwd, even inside a mounted folder: the Kody CLI config dir
 * (login tokens, context keys and wrapping keys, this policy), SSH, GPG, git,
 * cloud CLI and package-manager credentials, and OS keyring files. Defense in
 * depth only: host commands run as the same OS user and can still read them.
 */
export function credentialDenylist(
	home: string = homedir(),
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Array<string> {
	const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config')
	const paths = [
		cliConfigDir(home),
		join(home, '.ssh'),
		join(home, '.gnupg'),
		join(home, '.git-credentials'),
		join(xdgConfig, 'git', 'credentials'),
		join(home, '.netrc'),
		join(home, '_netrc'),
		join(home, '.aws'),
		join(home, '.azure'),
		join(xdgConfig, 'gcloud'),
		join(xdgConfig, 'gh'),
		join(home, '.kube'),
		join(home, '.docker', 'config.json'),
		join(home, '.npmrc'),
		join(home, '.yarnrc.yml'),
		join(home, '.pypirc'),
		join(home, '.cargo', 'credentials'),
		join(home, '.cargo', 'credentials.toml'),
		join(home, '.password-store'),
		join(home, '.local', 'share', 'keyrings'),
	]
	if (platform === 'darwin') paths.push(join(home, 'Library', 'Keychains'))
	if (platform === 'win32') {
		const appData = env.APPDATA || join(home, 'AppData', 'Roaming')
		const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
		paths.push(
			join(appData, 'Microsoft', 'Credentials'),
			join(appData, 'Microsoft', 'Protect'),
			join(localAppData, 'Microsoft', 'Credentials'),
			join(appData, 'gcloud'),
			join(appData, 'GitHub CLI'),
		)
	}
	return [...new Set(paths.map((path) => normalize(path)))]
}

/** Both the lexical path and, where it exists, where it really points. */
async function deniedRoots(paths: ReadonlyArray<string>) {
	const roots = new Set<string>()
	for (const path of paths) {
		roots.add(normalize(path))
		const real = await realpath(path).catch(() => null)
		if (real) roots.add(real)
	}
	return [...roots].sort()
}

export function isDeniedPath(
	path: string,
	denied: ReadonlyArray<string>,
	platform: NodeJS.Platform = process.platform,
) {
	return denied.some((root) => isWithin(path, root, platform))
}

const deniedMessage = (path: string) =>
	`${path} holds credentials (the Kody CLI login and context keys, SSH, GPG, git, cloud CLI or package-manager logins, or the OS keyring), so runs can never use it, even inside a host folder.`

export function localPolicyPath(configDir: string = cliConfigDir()) {
	return join(configDir, 'execution-context-policy.json')
}

export class FsAccessError extends Error {
	constructor(
		readonly code: 'EACCES' | 'EROFS' | 'EINVAL' | 'ENOTSUP' | 'EFBIG',
		message: string,
	) {
		super(message)
	}
}

function isFsMode(value: unknown): value is FsMode {
	return value === 'ro' || value === 'rw'
}

function hasDotSegments(path: string) {
	return path.split(/[\\/]+/).some((part) => part === '.' || part === '..')
}

/**
 * Windows spells one folder several ways: drop the `\\?\` long-path prefix
 * (and `\\?\UNC\` for shares) so policy, grant, and run paths compare.
 */
export function plainPath(
	path: string,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform !== 'win32') return path
	if (/^[\\/]{2}\?[\\/]UNC[\\/]/i.test(path)) return `\\\\${path.slice(8)}`
	if (/^[\\/]{2}\?[\\/]/.test(path)) return path.slice(4)
	return path
}

/**
 * POSIX: starts at `/`. Windows: a drive (`C:\`, `C:/`) or a share
 * (`\\server\share`); a drive-relative `\folder` or a device path is not
 * a host folder.
 */
export function isAbsolute(
	path: string,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform !== 'win32') return isRooted(path)
	return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/?.]/.test(path)
}

/** Windows file systems compare names case-insensitively. */
export function samePath(
	a: string,
	b: string,
	platform: NodeJS.Platform = process.platform,
) {
	return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function isWithin(
	child: string,
	parent: string,
	platform: NodeJS.Platform = process.platform,
) {
	if (platform === 'win32') {
		child = child.toLowerCase()
		parent = parent.toLowerCase()
	}
	if (child === parent) return true
	const sep = platform === 'win32' ? win32.sep : posix.sep
	const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`
	return child.startsWith(prefix)
}

/** An example host folder for this machine, for error messages and help. */
export function examplePath(platform: NodeJS.Platform = process.platform) {
	return platform === 'win32' ? 'C:\\Users\\you\\project' : '/absolute/path'
}

function narrower(a: FsMode, b: FsMode): FsMode {
	return a === 'ro' || b === 'ro' ? 'ro' : 'rw'
}

/** Absolute, free of `.`/`..` segments, and resolved through symlinks. */
async function canonicalize(path: string): Promise<string> {
	path = plainPath(path)
	if (!isAbsolute(path)) {
		throw new FsAccessError('EINVAL', `${path} is not an absolute path.`)
	}
	if (hasDotSegments(path)) {
		throw new FsAccessError(
			'EINVAL',
			`${path} contains "." or ".." segments. Use the plain absolute path.`,
		)
	}
	return await realpath(normalize(path))
}

export async function readLocalPolicy(
	path: string = localPolicyPath(),
): Promise<LocalFsPolicy> {
	let text: string
	try {
		text = await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { version: 1, fs: [] }
		}
		throw error
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		throw new Error(
			`${path} is not valid JSON. Fix it or recreate it with \`kody context policy allow <path>\`.`,
		)
	}
	const fs = (parsed as { fs?: unknown })?.fs
	if (
		(parsed as { version?: unknown })?.version !== 1 ||
		!Array.isArray(fs) ||
		!fs.every(
			(rule) =>
				typeof rule?.path === 'string' &&
				isAbsolute(rule.path) &&
				isFsMode(rule.mode),
		)
	) {
		throw new Error(
			`${path} must look like {"version":1,"fs":[{"path":${JSON.stringify(examplePath())},"mode":"ro"|"rw"}]}.`,
		)
	}
	const commands = (parsed as { commands?: unknown }).commands as
		| { enabled?: unknown; changedAt?: unknown }
		| undefined
	if (commands !== undefined && typeof commands?.enabled !== 'boolean') {
		throw new Error(
			`${path} has an invalid "commands" entry. Use \`kody context commands on|off\` to fix it.`,
		)
	}
	const autoUpdate = (parsed as { autoUpdate?: unknown }).autoUpdate as
		| { enabled?: unknown; changedAt?: unknown }
		| undefined
	if (autoUpdate !== undefined && typeof autoUpdate?.enabled !== 'boolean') {
		throw new Error(
			`${path} has an invalid "autoUpdate" entry. Use \`kody daemon auto-update on|off\` to fix it.`,
		)
	}
	const toggle = (value: { enabled?: unknown; changedAt?: unknown }) => ({
		enabled: value.enabled as boolean,
		...(typeof value.changedAt === 'string'
			? { changedAt: value.changedAt }
			: {}),
	})
	return {
		version: 1,
		fs: (fs as Array<FsRule>).map(({ path, mode }) => ({ path, mode })),
		...(commands ? { commands: toggle(commands) } : {}),
		...(autoUpdate ? { autoUpdate: toggle(autoUpdate) } : {}),
	}
}

export async function setLocalAutoUpdateEnabled(input: {
	enabled: boolean
	policyPath?: string
}) {
	const policyPath = input.policyPath ?? localPolicyPath()
	const current = await readLocalPolicy(policyPath)
	const next: LocalFsPolicy = {
		...current,
		autoUpdate: { enabled: input.enabled, changedAt: new Date().toISOString() },
	}
	await writeLocalPolicy(policyPath, next)
	return next
}

/** Whether this machine's owner turned host commands on locally. */
export async function readLocalCommandsEnabled(
	path: string = localPolicyPath(),
) {
	return (await readLocalPolicy(path)).commands?.enabled === true
}

export async function setLocalCommandsEnabled(input: {
	enabled: boolean
	policyPath?: string
}) {
	const policyPath = input.policyPath ?? localPolicyPath()
	const current = await readLocalPolicy(policyPath)
	const next: LocalFsPolicy = {
		...current,
		commands: { enabled: input.enabled, changedAt: new Date().toISOString() },
	}
	await writeLocalPolicy(policyPath, next)
	return next
}

async function writeLocalPolicy(path: string, policy: LocalFsPolicy) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const temp = `${path}.${process.pid}.tmp`
	await writeFile(temp, `${JSON.stringify(policy, null, 2)}\n`, {
		mode: 0o600,
	})
	await rename(temp, path)
}

/** Adds or replaces one rule, stored as its canonical (realpath) form. */
export async function allowLocalPath(input: {
	path: string
	mode: FsMode
	policyPath?: string
}) {
	const policyPath = input.policyPath ?? localPolicyPath()
	const canonical = await canonicalize(input.path).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`${input.path} does not exist on this machine.`)
		}
		throw error
	})
	const policy = await readLocalPolicy(policyPath)
	const fs = policy.fs.filter((rule) => !samePath(rule.path, canonical))
	fs.push({ path: canonical, mode: input.mode })
	fs.sort((a, b) => a.path.localeCompare(b.path))
	const next: LocalFsPolicy = {
		version: 1,
		fs,
		...(policy.commands ? { commands: policy.commands } : {}),
		...(policy.autoUpdate ? { autoUpdate: policy.autoUpdate } : {}),
	}
	await writeLocalPolicy(policyPath, next)
	return { policy: next, added: { path: canonical, mode: input.mode } }
}

export async function removeLocalPath(input: {
	path: string
	policyPath?: string
}) {
	const policyPath = input.policyPath ?? localPolicyPath()
	const policy = await readLocalPolicy(policyPath)
	const canonical = await canonicalize(input.path).catch(() => input.path)
	const fs = policy.fs.filter(
		(rule) =>
			!samePath(rule.path, canonical) && !samePath(rule.path, input.path),
	)
	const removed = fs.length !== policy.fs.length
	const next: LocalFsPolicy = {
		version: 1,
		fs,
		...(policy.commands ? { commands: policy.commands } : {}),
		...(policy.autoUpdate ? { autoUpdate: policy.autoUpdate } : {}),
	}
	if (removed) await writeLocalPolicy(policyPath, next)
	return { policy: next, removed }
}

/**
 * A folder is mounted only where both layers allow it, at the narrower mode.
 * Both sides are canonicalized, so a symlinked grant path is judged by where
 * it really points.
 */
export async function effectiveFs(
	grant: ReadonlyArray<{ path: string; mode: string }>,
	policy: ReadonlyArray<FsRule>,
	denylist: ReadonlyArray<string> = credentialDenylist(),
): Promise<EffectiveFs> {
	const denied = await deniedRoots(denylist)
	const rules: Array<FsRule> = []
	for (const rule of policy) {
		const path = await canonicalize(rule.path).catch(() => null)
		if (path) rules.push({ path, mode: rule.mode })
	}
	const mounts = new Map<string, FsMode>()
	const refused: Array<FsRefusal> = []
	const grantRoots = new Set<string>()
	for (const entry of grant) {
		const mode: FsMode = entry.mode === 'rw' ? 'rw' : 'ro'
		const grantPath = plainPath(entry.path)
		if (!isAbsolute(grantPath) || hasDotSegments(grantPath)) {
			refused.push({
				path: entry.path,
				layer: 'server_grant',
				reason: 'grant paths must be plain absolute paths',
			})
			continue
		}
		grantRoots.add(normalize(grantPath))
		const path = await realpath(grantPath).catch(() => null)
		if (!path) {
			refused.push({
				path: entry.path,
				layer: 'local_policy',
				reason: 'it does not exist on this machine',
			})
			continue
		}
		grantRoots.add(path)
		let matched = false
		for (const rule of rules) {
			const overlap = isWithin(path, rule.path)
				? path
				: isWithin(rule.path, path)
					? rule.path
					: null
			if (!overlap) continue
			matched = true
			const next = narrower(mode, rule.mode)
			const current = mounts.get(overlap)
			mounts.set(overlap, current === 'rw' ? 'rw' : next)
		}
		if (!matched) {
			refused.push({
				path: entry.path,
				layer: 'local_policy',
				reason: "this machine's local policy does not allow it",
			})
		}
	}
	for (const path of mounts.keys()) {
		if (!isDeniedPath(path, denied)) continue
		mounts.delete(path)
		refused.push({
			path,
			layer: 'credential_denylist',
			reason: 'it holds credentials and is never shared with runs',
		})
	}
	return {
		mounts: [...mounts]
			.map(([path, mode]) => ({ path, mode }))
			.sort((a, b) => a.path.localeCompare(b.path)),
		refused,
		grantRoots: [...grantRoots].sort(),
		denied,
	}
}

/** Resolves through symlinks for the deepest existing ancestor of `path`. */
async function resolveExisting(
	path: string,
	followFinal: boolean,
	depth = 0,
): Promise<string> {
	if (!followFinal) {
		const parent = dirname(path)
		if (parent === path) return path
		return join(await resolveExisting(parent, true), basename(path))
	}
	try {
		return await realpath(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		const parent = dirname(path)
		if (parent === path) return path
		const resolvedParent = await resolveExisting(parent, true)
		const entry = join(resolvedParent, basename(path))
		// A dangling symlink: writes would follow it, so resolve where it points.
		const link = await lstat(entry).catch(() => null)
		if (link?.isSymbolicLink()) {
			if (depth >= 40) {
				throw new FsAccessError('EACCES', `Too many symlinks at ${path}.`)
			}
			const target = plainPath(await readlink(entry))
			return await resolveExisting(
				isAbsolute(target) ? target : join(resolvedParent, target),
				true,
				depth + 1,
			)
		}
		return entry
	}
}

/**
 * Maps a path the run asked for to the host path it may use, or throws an
 * error naming the layer (server grant or local policy) that refused it.
 */
export async function resolveHostPath(
	effective: EffectiveFs,
	path: string,
	access: 'read' | 'write',
	options: { followFinal?: boolean; allowMountRoot?: boolean } = {},
) {
	if (typeof path !== 'string' || !isAbsolute(plainPath(path))) {
		throw new FsAccessError(
			'EINVAL',
			`Execution context host folders need absolute paths like ${examplePath()} (got ${String(path)}).`,
		)
	}
	const lexical = normalize(plainPath(path))
	const real = await resolveExisting(lexical, options.followFinal ?? true)
	if (
		isDeniedPath(lexical, effective.denied) ||
		isDeniedPath(real, effective.denied)
	) {
		throw new FsAccessError('EACCES', deniedMessage(path))
	}
	const mount = effective.mounts
		.filter((candidate) => isWithin(real, candidate.path))
		.sort((a, b) => b.path.length - a.path.length)[0]
	if (!mount) {
		const granted = effective.grantRoots.some(
			(root) => isWithin(lexical, root) || isWithin(real, root),
		)
		throw new FsAccessError(
			'EACCES',
			granted
				? `${path} is in this execution context's server grant, but this machine's local policy does not allow it. The machine owner can allow it with \`kody context policy allow <folder> --mode ro|rw\`.`
				: `${path} is outside this execution context's server grant (grant.fs). Someone with Contribute on the context can add the folder with executionContextUpdate; the machine's local policy must also allow it.`,
		)
	}
	if (access === 'write' && mount.mode === 'ro') {
		throw new FsAccessError(
			'EROFS',
			`${path} is read-only in this execution context: ${mount.path} is mounted ro (the narrower of the server grant and this machine's local policy).`,
		)
	}
	if (
		access === 'write' &&
		!options.allowMountRoot &&
		samePath(real, mount.path)
	) {
		throw new FsAccessError(
			'EACCES',
			`${path} is the root of a host folder mount and cannot be removed or renamed from a run.`,
		)
	}
	return real
}

export function fsFeatures(effective: EffectiveFs) {
	return effective.mounts.length > 0 ? ['fs'] : []
}
