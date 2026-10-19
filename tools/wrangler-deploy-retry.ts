import { spawn } from 'node:child_process'
import { isRetryableCloudflareFailure } from './ci/resource-utils.ts'

const wranglerDeployRetryMaxAttempts = 4
const wranglerDeployRetryBaseDelayMs = 1_000

export function isRetryableWorkersDevSubdomainRace(output: string) {
	const uploaded = /uploaded\s+\S+/i.test(output)
	const missingAfterUpload =
		/\b10007\b/.test(output) &&
		/this worker does not exist on your account/i.test(output)
	return uploaded && missingAfterUpload
}

const workersDevSubdomainRaceMinDelayMs = 10_000

/**
 * A redeploy soon after the 10007 race can crash wrangler on the half-created
 * Worker's settings. Only retried when the previous attempt hit the race.
 */
function isWranglerCrashAfterSubdomainRace(output: string) {
	return /Cannot read properties of null \(reading 'tag'\)/.test(output)
}

export function isRetryableWranglerDeployFailure(output: string) {
	return (
		isRetryableWorkersDevSubdomainRace(output) ||
		isRetryableCloudflareFailure(output)
	)
}

export function isWranglerD1MigrationsApply(args: ReadonlyArray<string>) {
	return args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply'
}

export type WranglerDeployRunResult = {
	status: number
	output: string
	errorMessage: string
}

export type WranglerDeployRun = (
	command: string,
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
) => WranglerDeployRunResult | Promise<WranglerDeployRunResult>

/**
 * Stream stdout/stderr to the parent (no spawnSync maxBuffer) and wait for
 * `close` so the last pipe chunks are captured before retry classification.
 */
export function spawnWranglerDeploy(
	command: string,
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
	forwardTo: {
		stdout?: NodeJS.WritableStream
		stderr?: NodeJS.WritableStream
	} = {},
): Promise<WranglerDeployRunResult> {
	const stdout = forwardTo.stdout ?? process.stdout
	const stderr = forwardTo.stderr ?? process.stderr
	return new Promise((resolve) => {
		const chunks: Array<string> = []
		const child = spawn(command, [...args], {
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
		function finish(result: WranglerDeployRunResult) {
			if (settled) return
			settled = true
			resolve(result)
		}
		child.once('error', (error) => {
			finish({
				status: 1,
				output: chunks.join(''),
				errorMessage: error.message,
			})
		})
		child.once('close', (code) => {
			finish({
				status: code ?? 1,
				output: chunks.join(''),
				errorMessage: '',
			})
		})
	})
}

export async function runWranglerDeployWithRetry(input: {
	command: string
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	maxAttempts?: number
	baseDelayMs?: number
	sleep?: (ms: number) => Promise<void>
	run?: WranglerDeployRun
	log?: (line: string) => void
}) {
	const maxAttempts = input.maxAttempts ?? wranglerDeployRetryMaxAttempts
	const baseDelayMs = input.baseDelayMs ?? wranglerDeployRetryBaseDelayMs
	const wait =
		input.sleep ??
		((ms: number) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms)
			}))
	const run = input.run ?? spawnWranglerDeploy
	const log =
		input.log ??
		((line) => {
			console.error(line)
		})

	let last = await run(input.command, input.args, input.env)
	let sawSubdomainRace = false
	for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
		if (last.status === 0) return last
		const combined = `${last.output} ${last.errorMessage}`
		const subdomainRace = isRetryableWorkersDevSubdomainRace(combined)
		const crashAfterRace =
			sawSubdomainRace && isWranglerCrashAfterSubdomainRace(combined)
		sawSubdomainRace ||= subdomainRace
		if (!crashAfterRace && !isRetryableWranglerDeployFailure(combined)) {
			return last
		}
		// The 10007 race heals over tens of seconds, not the 1-4s base backoff.
		const delayMs =
			(sawSubdomainRace
				? Math.max(baseDelayMs, workersDevSubdomainRaceMinDelayMs)
				: baseDelayMs) *
			2 ** (attempt - 1)
		log(
			`Retrying wrangler (attempt ${attempt + 1}/${maxAttempts}) in ${String(delayMs)}ms after a transient Cloudflare failure${sawSubdomainRace ? ' (workers.dev 10007 race)' : ''}.`,
		)
		await wait(delayMs)
		last = await run(input.command, input.args, input.env)
	}
	return last
}
