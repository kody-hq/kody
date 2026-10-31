import { execFileSync } from 'node:child_process'
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

/** A workerd a run started, as recorded on disk. */
type WorkerRecord = {
	pid: number
	/** The run's `config.capnp`; must appear in the process command line. */
	configPath: string
	/** The daemon that started it. */
	ownerPid: number
}

export type LocalWorkerTracker = {
	started(input: { pid: number; configPath: string }): void
	exited(pid: number): void
}

type ProcessOps = {
	isAlive(pid: number): boolean
	commandLine(pid: number): string | null
	kill(pid: number): void
}

const defaultOps: ProcessOps = {
	isAlive(pid) {
		try {
			process.kill(pid, 0)
			return true
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'EPERM'
		}
	},
	commandLine(pid) {
		try {
			if (process.platform === 'linux') {
				return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll(
					'\0',
					' ',
				)
			}
			if (process.platform === 'win32') return null
			return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
			})
		} catch {
			return null
		}
	},
	kill(pid) {
		try {
			process.kill(pid, 'SIGKILL')
		} catch {
			// Already gone.
		}
	},
}

function readRecord(path: string): WorkerRecord | null {
	try {
		const value = JSON.parse(readFileSync(path, 'utf8')) as WorkerRecord
		return Number.isInteger(value.pid) &&
			value.pid > 0 &&
			typeof value.configPath === 'string' &&
			value.configPath.endsWith('config.capnp') &&
			Number.isInteger(value.ownerPid)
			? value
			: null
	} catch {
		return null
	}
}

/**
 * Kills the workerd processes an earlier daemon for this context left
 * behind (it was SIGKILLed or crashed, so its exit handlers never ran) and
 * removes their temp dirs. A pid is only killed while its command line
 * still names the run's config file, so a reused pid is left alone, and
 * records owned by a daemon that is still running are skipped.
 */
export function reapLeftoverWorkers(
	dir: string,
	input: { selfPid?: number; ops?: ProcessOps } = {},
) {
	const ops = input.ops ?? defaultOps
	const selfPid = input.selfPid ?? process.pid
	let entries: Array<string>
	try {
		entries = readdirSync(dir).filter((name) => name.endsWith('.json'))
	} catch {
		return []
	}
	const killed: Array<number> = []
	for (const name of entries) {
		const path = join(dir, name)
		const record = readRecord(path)
		if (!record) {
			rmSync(path, { force: true })
			continue
		}
		if (record.ownerPid !== selfPid && ops.isAlive(record.ownerPid)) continue
		if (
			ops.isAlive(record.pid) &&
			ops.commandLine(record.pid)?.includes(record.configPath)
		) {
			ops.kill(record.pid)
			killed.push(record.pid)
		}
		rmSync(dirname(record.configPath), { recursive: true, force: true })
		rmSync(path, { force: true })
	}
	return killed
}

/**
 * Records each run's workerd under `dir` while it runs and kills any that
 * are still alive when the daemon process exits. Signals are covered by
 * `runLocalExecute`'s own handlers; SIGKILL skips every handler, so the next
 * daemon for the context reaps the records with `reapLeftoverWorkers`.
 */
export function createLocalWorkerTracker(
	dir: string,
	input: { ops?: Pick<ProcessOps, 'kill'> } = {},
): LocalWorkerTracker & { killAll(): void; dispose(): void } {
	const ops = input.ops ?? defaultOps
	const live = new Set<number>()
	const recordPath = (pid: number) => join(dir, `${pid}.json`)
	const killAll = () => {
		for (const pid of live) {
			ops.kill(pid)
			rmSync(recordPath(pid), { force: true })
		}
		live.clear()
	}
	process.on('exit', killAll)
	return {
		started({ pid, configPath }) {
			live.add(pid)
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 })
				const record: WorkerRecord = {
					pid,
					configPath,
					ownerPid: process.pid,
				}
				writeFileSync(recordPath(pid), JSON.stringify(record), {
					mode: 0o600,
				})
			} catch {
				// The exit handler still covers this process; only a SIGKILL would leak.
			}
		},
		exited(pid) {
			live.delete(pid)
			rmSync(recordPath(pid), { force: true })
		},
		killAll,
		dispose() {
			process.off('exit', killAll)
		},
	}
}
