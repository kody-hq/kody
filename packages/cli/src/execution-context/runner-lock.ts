import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { uptime } from 'node:os'
import { dirname } from 'node:path'
import psList from 'ps-list'

/**
 * One runner per execution context on a machine. Every launcher (a service, a
 * terminal, the desktop app) takes `daemon.lock` next to the daemon state, so
 * a second daemon for the same context refuses (or, as a service, waits)
 * instead of replacing the first one on the server in a loop.
 */

/** Who started a daemon: the desktop app sets this for the runner it owns. */
export const launcherEnvVar = 'KODY_DAEMON_LAUNCHER'

export type RunnerLauncher = 'systemd' | 'launchd' | 'terminal' | 'desktop'

export type RunnerLockHolder = {
	pid: number
	version: string
	launcher: RunnerLauncher
	startedAt: string
}

/** A lock file younger than this with no readable holder is still being written. */
const unreadableGraceMs = 10_000

export function lockPathFor(statePath: string) {
	return statePath.replace(/daemon\.json$/, 'daemon.lock')
}

export function isAlive(pid: number) {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

function commandOf(pid: number): string | null {
	if (process.platform === 'win32') return null
	try {
		return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore'],
			timeout: 2_000,
		}).trim()
	} catch {
		return null
	}
}

export type HolderCheck = {
	isAlive?: (pid: number) => boolean
	/** The process's command line, or null when it cannot be read. */
	commandOf?: (pid: number) => string | null
	bootTimeMs?: number
}

/**
 * Whether the recorded holder still runs. The lock outlives reboots and
 * crashes, so a live pid alone is not enough: the pid may now belong to an
 * unrelated process. It must have started after boot and still be a daemon.
 */
export function isLiveHolder(
	holder: RunnerLockHolder,
	check: HolderCheck = {},
) {
	if (!(check.isAlive ?? isAlive)(holder.pid)) return false
	if (holder.pid === process.pid) return true
	const startedAt = Date.parse(holder.startedAt)
	const bootTimeMs = check.bootTimeMs ?? Date.now() - uptime() * 1000
	if (Number.isFinite(startedAt) && startedAt < bootTimeMs - 60_000) {
		return false
	}
	const command = (check.commandOf ?? commandOf)(holder.pid)
	return command === null || /\bdaemon\b/.test(command)
}

type LockRead = RunnerLockHolder | 'missing' | 'malformed' | 'unreadable'

function readLock(path: string): LockRead {
	let text: string
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT'
			? 'missing'
			: 'unreadable'
	}
	try {
		const holder = JSON.parse(text) as RunnerLockHolder
		return typeof holder?.pid === 'number' ? holder : 'malformed'
	} catch {
		return 'malformed'
	}
}

function readHolder(path: string): RunnerLockHolder | null {
	const read = readLock(path)
	return typeof read === 'object' ? read : null
}

function sameHolder(a: RunnerLockHolder, b: RunnerLockHolder) {
	return a.pid === b.pid && a.startedAt === b.startedAt
}

/** The live daemon holding this context's lock, if any. */
export function runnerLockHolder(
	path: string,
	check: HolderCheck = {},
): RunnerLockHolder | null {
	const holder = readHolder(path)
	return holder && isLiveHolder(holder, check) ? holder : null
}

export type RunnerLock =
	| { ok: true; release: () => void }
	| { ok: false; holder: RunnerLockHolder }

export function acquireRunnerLock(
	path: string,
	info: Omit<RunnerLockHolder, 'pid'> & { pid?: number },
	check: HolderCheck = {},
): RunnerLock {
	const mine: RunnerLockHolder = { ...info, pid: info.pid ?? process.pid }
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	const unique = () => `${process.pid}-${randomBytes(4).toString('hex')}`
	for (let attempt = 0; attempt < 3; attempt++) {
		// Write the whole holder first, then link it into place: the lock never
		// exists half-written, and link fails atomically if another daemon won.
		const temp = `${path}.${unique()}.tmp`
		writeFileSync(temp, `${JSON.stringify(mine)}\n`, { mode: 0o600 })
		try {
			linkSync(temp, path)
			return {
				ok: true,
				release: () => {
					const holder = readHolder(path)
					if (holder && sameHolder(holder, mine)) rmSync(path, { force: true })
				},
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		} finally {
			rmSync(temp, { force: true })
		}
		const read = readLock(path)
		if (read === 'missing') continue
		const holder = typeof read === 'object' ? read : null
		if (read === 'unreadable') {
			// Owned by another user (say, a daemon run as root): never reclaim it.
			return {
				ok: false,
				holder: {
					pid: 0,
					version: 'unknown',
					launcher: 'terminal',
					startedAt: 'unreadable',
				},
			}
		}
		if (!holder) {
			let ageMs = Infinity
			try {
				ageMs = Date.now() - statSync(path).mtimeMs
			} catch {
				continue
			}
			if (ageMs < unreadableGraceMs) {
				return {
					ok: false,
					holder: {
						pid: 0,
						version: 'unknown',
						launcher: 'terminal',
						startedAt: new Date(Date.now() - ageMs).toISOString(),
					},
				}
			}
		} else if (holder.pid !== mine.pid && isLiveHolder(holder, check)) {
			return { ok: false, holder }
		}
		// A crashed daemon left it behind. Move it aside rather than delete it,
		// so a lock another daemon took in the meantime is put back, not lost.
		const aside = `${path}.${unique()}.stale`
		try {
			renameSync(path, aside)
		} catch {
			continue
		}
		const moved = readHolder(aside)
		if (
			moved &&
			(!holder || !sameHolder(moved, holder)) &&
			moved.pid !== mine.pid &&
			isLiveHolder(moved, check)
		) {
			try {
				linkSync(aside, path)
			} catch {}
			rmSync(aside, { force: true })
			return { ok: false, holder: moved }
		}
		rmSync(aside, { force: true })
	}
	const holder = readHolder(path)
	if (holder) return { ok: false, holder }
	throw new Error(`Could not take the runner lock ${path}.`)
}

export function describeLauncher(launcher: RunnerLauncher | undefined) {
	if (launcher === 'systemd') return 'the systemd service'
	if (launcher === 'launchd') return 'the launchd service'
	if (launcher === 'desktop') return 'the Kody desktop app'
	return 'a terminal'
}

export function describeHolder(holder: RunnerLockHolder) {
	if (holder.pid === 0 && holder.startedAt === 'unreadable') {
		return 'a daemon of another user holds the lock (this user cannot read it)'
	}
	if (holder.pid === 0) {
		return `another daemon is taking the lock right now (since ${holder.startedAt})`
	}
	return `pid ${holder.pid}, kody ${holder.version}, started by ${describeLauncher(holder.launcher)} at ${holder.startedAt}`
}

/**
 * Other local `kody daemon` processes for this context, by command line
 * (daemons from CLIs older than the lock do not take it).
 */
export async function otherLocalDaemons(input: {
	ecid: string
	listProcesses?: () => Promise<Array<{ pid: number; cmd?: string }>>
	exclude?: Array<number>
}) {
	let processes: Array<{ pid: number; cmd?: string }>
	try {
		processes = await (input.listProcesses ?? psList)()
	} catch {
		return []
	}
	const skip = new Set([process.pid, process.ppid, ...(input.exclude ?? [])])
	return processes.filter(
		(entry) =>
			!skip.has(entry.pid) &&
			typeof entry.cmd === 'string' &&
			/\bdaemon\b/.test(entry.cmd) &&
			entry.cmd.includes(input.ecid) &&
			/kody|@kodycodes/.test(entry.cmd),
	)
}
