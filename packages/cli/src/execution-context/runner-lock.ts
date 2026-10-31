import {
	closeSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
	mkdirSync,
} from 'node:fs'
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

function readHolder(path: string): RunnerLockHolder | null {
	try {
		const holder = JSON.parse(readFileSync(path, 'utf8')) as RunnerLockHolder
		return typeof holder.pid === 'number' ? holder : null
	} catch {
		return null
	}
}

/** The live daemon holding this context's lock, if any. */
export function runnerLockHolder(path: string): RunnerLockHolder | null {
	const holder = readHolder(path)
	return holder && isAlive(holder.pid) ? holder : null
}

export type RunnerLock =
	| { ok: true; release: () => void }
	| { ok: false; holder: RunnerLockHolder }

export function acquireRunnerLock(
	path: string,
	info: Omit<RunnerLockHolder, 'pid'> & { pid?: number },
): RunnerLock {
	const mine: RunnerLockHolder = { ...info, pid: info.pid ?? process.pid }
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(path, 'wx', 0o600)
			writeSync(fd, `${JSON.stringify(mine)}\n`)
			closeSync(fd)
			return {
				ok: true,
				release: () => {
					if (readHolder(path)?.pid === mine.pid) rmSync(path, { force: true })
				},
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		const holder = readHolder(path)
		if (holder && holder.pid !== mine.pid && isAlive(holder.pid)) {
			return { ok: false, holder }
		}
		// A crashed daemon left it behind (or it is ours from a re-exec).
		rmSync(path, { force: true })
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
