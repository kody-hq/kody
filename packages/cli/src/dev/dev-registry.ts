/**
 * Where a running `kody dev` server advertises itself so `kody dev fetch` can
 * reuse it instead of booting a second workerd. One JSON file per package root
 * + target under the user cache dir; stale entries (dead pid, wrong package)
 * are ignored.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KodyTarget } from '../target.js'
import { userCacheDir } from '../workerd-binary.js'
import { isProcessAlive } from './process-reaper.js'

export const devStatusPath = '/__kody/dev/status'
/** Email the local Kody would have delivered, newest last. */
export const devOutboxPath = '/__kody/dev/outbox'

export type DevRegistration = {
	pid: number
	/** Origin, e.g. `http://127.0.0.1:4321`. */
	origin: string
	port: number
	basePath: string
	target: KodyTarget
	root: string
}

export type DevServerStatus = {
	ok: boolean
	state: 'starting' | 'building' | 'ready' | 'build_error'
	buildId: number | null
	url: string
	port: number
	basePath: string
	target: KodyTarget
	package: { name: string; kodyId: string; root: string }
	pid: number
	startedAt: string
	lastRebuild: { ms: number; at: string } | null
	lastError:
		| {
				kind: 'build'
				message: string
				file: string | null
				line: number | null
				col: number | null
				at: string
		  }
		| {
				kind: 'runtime'
				message: string
				stack: string
				request: { id: string; method: string; path: string } | null
				fix?: string
				at: string
		  }
		| null
}

export function devRegistryPath(
	root: string,
	target: KodyTarget,
	cacheDir: string = userCacheDir(),
): string {
	const key = createHash('sha256')
		.update(`${root}\0${target}`)
		.digest('hex')
		.slice(0, 16)
	return join(cacheDir, 'dev-servers', `${key}.json`)
}

export async function writeDevRegistration(
	registration: DevRegistration,
	cacheDir?: string,
): Promise<string> {
	const path = devRegistryPath(registration.root, registration.target, cacheDir)
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, `${JSON.stringify(registration, null, 2)}\n`)
	return path
}

/**
 * Remove the entry only if it still belongs to `pid`. Missing or unreadable
 * files are left alone — a successor may have truncated or rewritten the path
 * before our shutdown finishes (same rule as `--ready-file` cleanup).
 */
export async function removeDevRegistration(
	root: string,
	pid: number,
	target: KodyTarget,
	cacheDir?: string,
): Promise<void> {
	const path = devRegistryPath(root, target, cacheDir)
	try {
		const current = await readRegistration(path)
		if (!current || current.pid !== pid) return
		await rm(path, { force: true })
	} catch {
		// Missing or unreadable — nothing to clean up.
	}
}

/**
 * The live `kody dev` server for `root` on `target`, confirmed via its status
 * endpoint, or null.
 */
export async function findRunningDevServer(input: {
	root: string
	target: KodyTarget
	cacheDir?: string
	fetchFn?: typeof fetch
	timeoutMs?: number
}): Promise<{ registration: DevRegistration; status: DevServerStatus } | null> {
	const path = devRegistryPath(input.root, input.target, input.cacheDir)
	const registration = await readRegistration(path)
	if (!registration || registration.root !== input.root) return null
	if (!isProcessAlive(registration.pid)) {
		// Re-read before deleting: a successor may have rewritten the same path
		// after we snapped `registration` but before we noticed the pid was dead.
		const current = await readRegistration(path)
		if (current && current.pid === registration.pid) {
			await rm(path, { force: true })
		}
		return null
	}
	if (registration.target !== input.target) return null
	try {
		const response = await (input.fetchFn ?? fetch)(
			new URL(devStatusPath, registration.origin),
			{ signal: AbortSignal.timeout(input.timeoutMs ?? 1500) },
		)
		if (!response.ok) return null
		const status = (await response.json()) as DevServerStatus
		if (status.package?.root !== input.root || status.target !== input.target)
			return null
		return { registration, status }
	} catch {
		return null
	}
}

async function readRegistration(path: string): Promise<DevRegistration | null> {
	try {
		const parsed = JSON.parse(
			await readFile(path, 'utf8'),
		) as Partial<DevRegistration>
		if (
			typeof parsed.pid !== 'number' ||
			typeof parsed.origin !== 'string' ||
			typeof parsed.root !== 'string' ||
			(parsed.target !== 'mock' && parsed.target !== 'prod')
		) {
			return null
		}
		return {
			pid: parsed.pid,
			origin: parsed.origin,
			port:
				typeof parsed.port === 'number'
					? parsed.port
					: Number(new URL(parsed.origin).port),
			basePath: typeof parsed.basePath === 'string' ? parsed.basePath : '',
			target: parsed.target,
			root: parsed.root,
		}
	} catch {
		return null
	}
}
