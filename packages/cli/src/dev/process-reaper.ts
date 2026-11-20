/**
 * Keeps `kody dev` from leaking workerd processes and `/tmp/kody-dev-*` dirs.
 *
 * - A tiny detached `sh` reaper holds a pipe from this process. It learns
 *   workerd pids over that pipe and, when the pipe closes for any reason
 *   (including SIGKILL of the CLI), kills those pids and removes the work dir.
 * - On startup, {@link sweepStaleDevDirs} removes dirs and workerd processes
 *   left behind by dead CLI processes (including CLIs that predate the reaper).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import psList from 'ps-list'

export const devWorkDirPrefix = 'kody-dev-'
const ownerFileName = 'owner.json'
/**
 * Legacy dirs without an owner file are only removed once this old.
 * Remove when: no supported CLI version writes dev dirs without an owner file.
 */
const legacyDirMinAgeMs = 10 * 60_000

const reaperScript = `
pids=" "
while IFS= read -r line; do
  case "$line" in
    +*) pids="$pids\${line#+} " ;;
    -*) pids="$(printf '%s' "$pids" | sed "s/ \${line#-} / /g")" ;;
  esac
done
for entry in $pids; do
  case "$entry" in
    g*) /bin/kill -s KILL -- -\${entry#g} 2>/dev/null ;;
    *) /bin/kill -s KILL -- $entry 2>/dev/null ;;
  esac
done
rm -rf "$1"
`

export type ProcessReaper = {
	track: (pid: number) => void
	untrack: (pid: number) => void
	/** Track a detached process-group leader; hard CLI death SIGKILLs the whole tree. */
	trackGroup: (pid: number) => void
	untrackGroup: (pid: number) => void
	close: () => void
}

export async function startProcessReaper(input: {
	workDir: string
}): Promise<ProcessReaper> {
	await writeFile(
		join(input.workDir, ownerFileName),
		JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
	)
	let reaper: ChildProcess | undefined
	try {
		reaper = spawn(
			'/bin/sh',
			['-c', reaperScript, 'kody-dev-reaper', input.workDir],
			{
				stdio: ['pipe', 'ignore', 'ignore'],
				detached: true,
			},
		)
		reaper.on('error', () => {
			reaper = undefined
		})
		reaper.stdin?.on('error', () => {})
		reaper.unref()
		;(reaper.stdin as unknown as { unref?: () => void } | null)?.unref?.()
	} catch {
		reaper = undefined
	}
	const send = (line: string) => {
		if (reaper?.stdin?.writable) reaper.stdin.write(`${line}\n`)
	}
	return {
		track: (pid) => send(`+${pid}`),
		untrack: (pid) => send(`-${pid}`),
		trackGroup: (pid) => send(`+g${pid}`),
		untrackGroup: (pid) => send(`-g${pid}`),
		close: () => {
			reaper?.stdin?.end()
			reaper = undefined
		},
	}
}

type ListedProcess = { pid: number; ppid?: number; name: string; cmd?: string }

/**
 * Remove `kody-dev-*` work dirs whose owner is gone and kill workerd processes
 * still serving from them. Best effort; never throws.
 */
export async function sweepStaleDevDirs(
	input: {
		tmp?: string
		now?: number
		listProcesses?: () => Promise<Array<ListedProcess>>
		isAlive?: (pid: number) => boolean
		kill?: (pid: number) => void
	} = {},
): Promise<{ removed: Array<string>; killed: Array<number> }> {
	const tmp = input.tmp ?? tmpdir()
	const now = input.now ?? Date.now()
	const isAlive = input.isAlive ?? isProcessAlive
	const kill = input.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'))
	const removed: Array<string> = []
	const killed: Array<number> = []
	let entries: Array<string>
	try {
		entries = (await readdir(tmp)).filter((name) =>
			name.startsWith(devWorkDirPrefix),
		)
	} catch {
		return { removed, killed }
	}
	if (entries.length === 0) return { removed, killed }
	let processes: Array<ListedProcess> = []
	try {
		processes = await (input.listProcesses ?? psList)()
	} catch {
		processes = []
	}
	const byPid = new Map(processes.map((item) => [item.pid, item]))
	for (const name of entries) {
		const dir = join(tmp, name)
		try {
			const owner = await readOwnerPid(dir)
			if (owner !== null && isAlive(owner)) continue
			const workerds = processes.filter(
				(item) =>
					/workerd/.test(item.name) && (item.cmd ?? '').includes(`${dir}/`),
			)
			if (owner === null) {
				const info = await stat(dir)
				if (now - info.mtimeMs < legacyDirMinAgeMs) continue
				// Legacy CLI without an owner file: only reap workerds whose parent died.
				// Remove when: no supported CLI version writes dev dirs without an owner file.
				if (workerds.some((item) => !isOrphaned(item, byPid, isAlive))) continue
			}
			for (const item of workerds) {
				try {
					kill(item.pid)
					killed.push(item.pid)
				} catch {}
			}
			await rm(dir, { recursive: true, force: true })
			removed.push(dir)
		} catch {}
	}
	return { removed, killed }
}

function isOrphaned(
	item: ListedProcess,
	byPid: Map<number, ListedProcess>,
	isAlive: (pid: number) => boolean,
): boolean {
	if (item.ppid === undefined) return false
	if (item.ppid <= 1 || !isAlive(item.ppid)) return true
	const parent = byPid.get(item.ppid)
	return (
		parent !== undefined &&
		!/node|kody/i.test(`${parent.name} ${parent.cmd ?? ''}`)
	)
}

async function readOwnerPid(dir: string): Promise<number | null> {
	try {
		const parsed = JSON.parse(
			await readFile(join(dir, ownerFileName), 'utf8'),
		) as {
			pid?: unknown
		}
		return typeof parsed.pid === 'number' ? parsed.pid : null
	} catch {
		return null
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}
