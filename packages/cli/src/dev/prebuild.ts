/**
 * `kody.dev.prebuild`: a shell command `kody dev` runs from the package root
 * before every build, so generated assets (CSS, icons, data files) stay in
 * sync with the source without a second watcher process.
 */

import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { apiTokenEnvVar } from '../defaults.js'

const outputTailLines = 20

export class PrebuildError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PrebuildError'
	}
}

export async function runPrebuild(input: {
	command: string
	cwd: string
	onSpawn?: (pid: number) => void
	onExit?: (pid: number) => void
	onLine?: (line: string, stream: 'stdout' | 'stderr') => void
	/** When aborted, the child is SIGKILLed so graceful `kody dev` shutdown is not blocked. */
	signal?: AbortSignal
}): Promise<void> {
	if (input.signal?.aborted) {
		throw new PrebuildError('kody.dev.prebuild aborted before start')
	}
	const env: NodeJS.ProcessEnv = { ...process.env, KODY_DEV: '1' }
	delete env[apiTokenEnvVar]
	// New process group so abort can SIGKILL the whole tree (sh + npm/node/…).
	const child = spawn('sh', ['-c', input.command], {
		cwd: input.cwd,
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	})
	if (child.pid) input.onSpawn?.(child.pid)
	const tail: Array<string> = []
	const collect = (stream: 'stdout' | 'stderr') => (line: string) => {
		tail.push(line)
		if (tail.length > outputTailLines) tail.shift()
		input.onLine?.(line, stream)
	}
	forEachLine(child.stdout, collect('stdout'))
	forEachLine(child.stderr, collect('stderr'))

	const killChild = () => {
		if (child.exitCode !== null || child.signalCode !== null) return
		const pid = child.pid
		if (pid === undefined) return
		try {
			process.kill(-pid, 'SIGKILL')
		} catch {
			try {
				child.kill('SIGKILL')
			} catch {
				// already gone
			}
		}
	}
	if (input.signal) {
		if (input.signal.aborted) killChild()
		else input.signal.addEventListener('abort', killChild, { once: true })
	}

	try {
		const result = await new Promise<{
			code: number | null
			signal: NodeJS.Signals | null
		}>((resolve, reject) => {
			child.once('error', reject)
			child.once('close', (code, signal) => resolve({ code, signal }))
		})
		if (input.signal?.aborted) {
			throw new PrebuildError('kody.dev.prebuild aborted')
		}
		if (result.code === 0) return
		const how = result.signal
			? `signal ${result.signal}`
			: `exit ${result.code}`
		throw new PrebuildError(
			[
				`kody.dev.prebuild failed (${how}): ${input.command}`,
				...tail.map((line) => `  ${line}`),
			].join('\n'),
		)
	} finally {
		input.signal?.removeEventListener('abort', killChild)
		if (child.pid) input.onExit?.(child.pid)
	}
}

/** Split stream chunks into lines, including a final incomplete line on end. */
function forEachLine(
	stream: Readable | null,
	onLine: (line: string) => void,
): void {
	if (!stream) return
	let buffered = ''
	stream.on('data', (chunk: Buffer | string) => {
		buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
		const lines = buffered.split('\n')
		buffered = lines.pop() ?? ''
		for (const line of lines) {
			if (line.length > 0) onLine(line)
		}
	})
	stream.on('end', () => {
		if (buffered.length > 0) onLine(buffered)
		buffered = ''
	})
}
