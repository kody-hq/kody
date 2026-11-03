import { existsSync } from 'node:fs'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { text } from 'node:stream/consumers'
import { setTimeout as delay } from 'node:timers/promises'

export const nodeBin = process.execPath
export const wranglerBin = resolveWranglerBinary()

export type SpawnedProcess = ChildProcessByStdio<null, Readable, Readable> & {
	exited: Promise<number | null>
}

export function spawnProcess(input: {
	cmd: [string, ...Array<string>]
	cwd: string
	env?: NodeJS.ProcessEnv
}): SpawnedProcess {
	const proc = spawn(input.cmd[0], input.cmd.slice(1), {
		cwd: input.cwd,
		env: input.env,
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	const exited = new Promise<number | null>((resolve, reject) => {
		proc.once('error', reject)
		proc.once('exit', (code) => resolve(code))
	})

	return Object.assign(proc, { exited })
}

export function captureOutput(stream: NodeJS.ReadableStream | null) {
	let output = ''
	if (!stream) {
		return () => output
	}

	stream.on('data', (chunk) => {
		output += chunk.toString()
	})
	stream.on('error', () => {
		// Ignore stream errors while capturing output.
	})

	return () => output
}

export async function readOutput(stream: NodeJS.ReadableStream | null) {
	if (!stream) {
		return ''
	}

	return text(stream)
}

export async function stopProcess(proc: SpawnedProcess) {
	let exited = false
	void proc.exited
		.then(() => {
			exited = true
		})
		.catch(() => {
			exited = true
		})

	proc.kill('SIGINT')
	await Promise.race([proc.exited.catch(() => null), delay(5_000)])

	if (!exited) {
		proc.kill('SIGKILL')
		await proc.exited.catch(() => null)
	}
}

function resolveWranglerBinary() {
	const configuredBinary = process.env.WRANGLER_BINARY?.trim()
	if (configuredBinary) {
		return configuredBinary
	}

	const localBinary = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler',
	)
	return existsSync(localBinary) ? localBinary : 'wrangler'
}
