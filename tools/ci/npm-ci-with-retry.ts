import { spawn } from 'node:child_process'
import { isExecutedDirectly, resolveNpmCommand } from '../node-runtime.ts'
import { isRetryableNpmInstallFailure } from './retry-classifiers.ts'

export const npmCiRetryMaxAttempts = 3
export const npmCiRetryBaseDelayMs = 5_000

export type NpmCiAttemptResult = {
	status: number
	output: string
}

export type NpmCiRun = (
	extraArgs: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
) => NpmCiAttemptResult | Promise<NpmCiAttemptResult>

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms)
	})
}

/**
 * Stream npm ci while keeping the last pipe chunks so a retry decision can
 * read `ECONNRESET` after the child closes. Node built-ins only: setup-validate
 * runs this before `node_modules` exists.
 */
export function spawnNpmCi(
	extraArgs: ReadonlyArray<string> = [],
	env?: NodeJS.ProcessEnv,
	forwardTo: {
		stdout?: NodeJS.WritableStream
		stderr?: NodeJS.WritableStream
	} = {},
): Promise<NpmCiAttemptResult> {
	const stdout = forwardTo.stdout ?? process.stdout
	const stderr = forwardTo.stderr ?? process.stderr
	return new Promise((resolve) => {
		const chunks: Array<string> = []
		const child = spawn(resolveNpmCommand(), ['ci', ...extraArgs], {
			env,
			stdio: ['inherit', 'pipe', 'pipe'],
		})
		function forward(
			stream: NodeJS.ReadableStream | null,
			dest: NodeJS.WritableStream,
		) {
			if (!stream) return
			stream.on('data', (chunk: Buffer | string) => {
				const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
				chunks.push(text)
				dest.write(chunk)
			})
		}
		forward(child.stdout, stdout)
		forward(child.stderr, stderr)
		let settled = false
		function finish(result: NpmCiAttemptResult) {
			if (settled) return
			settled = true
			resolve(result)
		}
		child.once('error', (error) => {
			finish({
				status: 1,
				output: `${chunks.join('')}${error.message}`,
			})
		})
		child.once('close', (code) => {
			finish({
				status: code ?? 1,
				output: chunks.join(''),
			})
		})
	})
}

export async function runNpmCiWithRetry(
	input: {
		extraArgs?: ReadonlyArray<string>
		env?: NodeJS.ProcessEnv
		maxAttempts?: number
		baseDelayMs?: number
		sleep?: (ms: number) => Promise<void>
		run?: NpmCiRun
		log?: (line: string) => void
	} = {},
) {
	const extraArgs = input.extraArgs ?? []
	const maxAttempts = input.maxAttempts ?? npmCiRetryMaxAttempts
	const baseDelayMs = input.baseDelayMs ?? npmCiRetryBaseDelayMs
	const wait = input.sleep ?? sleep
	const run = input.run ?? spawnNpmCi
	const log =
		input.log ??
		((line) => {
			console.log(line)
		})

	let last = await run(extraArgs, input.env)
	for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
		if (last.status === 0) return last
		if (!isRetryableNpmInstallFailure(last.output)) {
			return last
		}
		const delayMs = baseDelayMs * 2 ** (attempt - 1)
		log(
			`::warning::npm ci hit a transient registry network error; retrying (attempt ${String(attempt + 1)}/${String(maxAttempts)}) in ${String(delayMs / 1000)}s.`,
		)
		await wait(delayMs)
		last = await run(extraArgs, input.env)
	}
	return last
}

export async function main(args = process.argv.slice(2)) {
	const extraArgs = args[0] === '--' ? args.slice(1) : args
	const result = await runNpmCiWithRetry({ extraArgs })
	process.exitCode = result.status === 0 ? 0 : result.status
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
