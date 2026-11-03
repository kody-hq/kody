/**
 * One workerd `serve` process for `kody dev`: spawn, wait for the control-fd
 * `listen` event, stream stdout/stderr line by line, and stop it.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { redact } from '../redact.js'

const workerdStartTimeoutMs = 30_000

export type WorkerdHandle = {
	pid: number
	port: number
	/** Resolves with a short exit description once the process is gone. */
	exited: Promise<string>
	kill: () => Promise<void>
}

export async function startWorkerd(input: {
	workerdPath: string
	configPath: string
	cwd: string
	env: NodeJS.ProcessEnv
	/** Called synchronously after spawn so callers can track the pid before listen. */
	onSpawn?: (pid: number) => void
	onStdoutLine: (line: string) => void
	onStderrLine: (line: string) => void
}): Promise<WorkerdHandle> {
	const child = spawn(
		input.workerdPath,
		['serve', input.configPath, '--control-fd=3'],
		{
			cwd: input.cwd,
			env: input.env,
			stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
		},
	)
	if (child.pid !== undefined) input.onSpawn?.(child.pid)

	let startupStderr = ''
	let listening = false
	forEachLine(child.stdout, input.onStdoutLine)
	forEachLine(child.stderr, (line) => {
		if (!listening) startupStderr += `${line}\n`
		input.onStderrLine(line)
	})

	const exited = new Promise<string>((resolve) => {
		child.once('exit', (code, signal) =>
			resolve(`workerd exit ${signal ?? code}`),
		)
		child.once('error', (error) => resolve(`workerd error: ${error.message}`))
	})

	const port = await waitForListen(child, exited, () => {
		const trimmed = redact(startupStderr.trim())
		return trimmed ? `\n${trimmed}` : ''
	})
	listening = true
	return {
		pid: child.pid ?? -1,
		port,
		exited,
		kill: async () => {
			if (child.exitCode !== null || child.signalCode !== null) return
			child.kill('SIGKILL')
			await Promise.race([
				exited,
				new Promise<void>((resolve) => setTimeout(resolve, 1000)),
			])
		},
	}
}

function forEachLine(
	stream: Readable | null,
	onLine: (line: string) => void,
): void {
	if (!stream) return
	const lines = createInterface({ input: stream, crlfDelay: Infinity })
	lines.on('line', (line) => {
		if (line.length > 0) onLine(line)
	})
}

function waitForListen(
	child: ChildProcess,
	exited: Promise<string>,
	stderr: () => string,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const control = child.stdio[3] as Readable | null
		let buffered = ''
		let settled = false
		const settle = (fn: () => void) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			fn()
		}
		const timer = setTimeout(() => {
			settle(() => {
				child.kill('SIGKILL')
				reject(
					new Error(
						`workerd did not start within ${workerdStartTimeoutMs / 1000}s.${stderr()}`,
					),
				)
			})
		}, workerdStartTimeoutMs)
		control?.on('data', (chunk: Buffer) => {
			buffered += chunk.toString('utf8')
			const lines = buffered.split('\n')
			buffered = lines.pop() ?? ''
			for (const line of lines) {
				const port = parseListenPort(line)
				if (port !== null) settle(() => resolve(port))
			}
		})
		void exited.then((detail) => {
			settle(() =>
				reject(new Error(`workerd failed to start (${detail})${stderr()}`)),
			)
		})
	})
}

export function parseListenPort(line: string): number | null {
	if (!line.trim()) return null
	try {
		const event = JSON.parse(line) as {
			event?: string
			socket?: string
			port?: number
		}
		return event.event === 'listen' &&
			event.socket === 'http' &&
			typeof event.port === 'number'
			? event.port
			: null
	} catch {
		return null
	}
}

/**
 * Make workerd stderr readable: drop native `stack: …workerd@0x…` address
 * lines and the C++ source prefix on uncaught-exception lines. Returns null
 * for lines that carry nothing for a JS developer.
 */
export function cleanWorkerdStderrLine(line: string): string | null {
	const trimmed = line.trim()
	if (!trimmed) return null
	if (/^stack:(\s+\S+@[0-9a-fx]+)+\s*$/i.test(trimmed)) return null
	const prefixed =
		/^workerd\/\S+:\d+: (?:error|warning|info|debug): (.*)$/.exec(trimmed)
	const body = prefixed ? prefixed[1]! : trimmed
	return body
		.replace(/\S+\.(?:c\+\+|h):\d+: failed: /g, '')
		.replace(/(?:remote\.)?jsg\.(\w*Error)(?=:)/g, '$1')
}
