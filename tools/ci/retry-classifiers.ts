import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isExecutedDirectly } from '../node-runtime.ts'

const ansiEscapePattern = new RegExp(`${'\u001b'}\\[[0-9;]*m`, 'g')

function stripLogAnsi(text: string) {
	return text.replace(ansiEscapePattern, '')
}

/**
 * Permanent Cloudflare auth failures must not be retried. 401/403 and
 * wrangler "Authentication error [code: 10000]" stay in this set so a bad
 * token cannot burn the preview cleanup budget.
 *
 * Cloudflare also returns HTTP 500 with
 * "Internal authentication error: internal server error" as a transient
 * platform blip (seen on scheduled preview sweeps). That phrasing matches a
 * naive `/authentication error/i` check, so 5xx envelopes and the Internal
 * wording (when not on 401/403) are excluded here and stay retryable via
 * `isRetryableCloudflareFailure`. Explicit 401/403 always win over wording.
 */
export function isPermanentCloudflareAuthFailure(message: string) {
	if (
		/Cloudflare API request failed \(401\)/.test(message) ||
		/Cloudflare API request failed \(403\)/.test(message)
	) {
		return true
	}
	if (
		/Cloudflare API request failed \(5\d\d\)/.test(message) ||
		/internal authentication error/i.test(message)
	) {
		return false
	}
	return (
		/authentication error/i.test(message) || /\[code:\s*10000\]/.test(message)
	)
}

export function isRetryableCloudflareFailure(message: string) {
	if (isPermanentCloudflareAuthFailure(message)) return false
	return (
		(message.includes('Malformed Cloudflare response') &&
			!/Malformed Cloudflare response \(200\).*--/u.test(message)) ||
		// Wrangler uses this phrasing for truncated JSON on 200 GET /deployments,
		// not only 5xx connect resets. Keep the multipart-200 exclusion above.
		message.includes('Received a malformed response from the API') ||
		message.includes('upstream connect error') ||
		message.includes('Cloudflare API request failed (429)') ||
		/Cloudflare API request failed \(5\d\d\)/.test(message) ||
		// Cloudflare platform blip (also appears in wrangler stderr without an
		// HTTP status envelope). Distinct from permanent "Authentication error".
		/internal authentication error/i.test(message) ||
		/504 Gateway Timeout/i.test(message) ||
		/Gateway Timeout/i.test(message) ||
		message.includes('fetch failed') ||
		message.includes('ECONNRESET') ||
		message.includes('ETIMEDOUT') ||
		message.includes('socket hang up')
	)
}

export function isRetryableCloudflareApiError(error: unknown) {
	if (!(error instanceof Error)) return false
	if (error.name === 'AbortError') return true
	return isRetryableCloudflareFailure(error.message)
}

/**
 * Cloudflare upload and secret-bulk failures that are worth a bounded retry.
 * 10021 (startup CPU) is treated as retryable because production uploads of
 * the same script often pass on the next attempt; persistent over-limit
 * still fails after the workflow's attempt budget. Wrangler "Received a
 * malformed response from the API" is the same edge flake class as
 * `isRetryableCloudflareApiError` — including a 200 on GET /deployments whose
 * JSON body is truncated. Secret-bulk 5xx stays covered even when that
 * wrangler phrase is absent.
 */
const retryableDeployFailurePatterns = [
	/workflows\.api\.error\.internal_server/i,
	/Cloudflare API[\s\S]*\[code:\s*10001\]/i,
	/Cloudflare API[\s\S]*\[code:\s*10021\]/i,
	/Script startup exceeded CPU time limit/i,
	/Received a malformed response from the API/i,
	/upstream connect error or disconnect\/reset/i,
	/Secrets failed to upload[\s\S]*-> 5\d\d/i,
	// Preview runtime uploads (~19MB) hit Cloudflare gateway timeouts on
	// GET .../deployments; production already retries these via wrangler, but
	// the outer workflow retry must recognize them too (#3512).
	/504 Gateway Timeout/i,
	/Gateway Timeout/i,
	/-> 504\b/i,
] as const

export function isRetryableDeployFailure(logText: string) {
	const text = stripLogAnsi(logText)
	return retryableDeployFailurePatterns.some((pattern) => pattern.test(text))
}

/**
 * Playwright prints this when `webServer.command` exits before `/health`
 * is reachable. No tests ran. Safe to retry once — a real config bug
 * fails the second attempt too. Covers the Vite
 * `ReferenceError: __LOAD__ is not defined` runner-worker crash during
 * Cloudflare live export-type inspection (Validate #36669175020). Do not
 * match `__LOAD__` alone: a recovered first start plus a later genuine
 * assertion failure must not retry the suite.
 */
const e2eWebServerStartFailurePattern =
	/Process from config\.webServer was not able to start/

const midSuiteWebServerDeathPatterns = [
	/E2eWebServerDeadError/,
	/ECONNREFUSED (?:127\.0\.0\.1|localhost):3847/,
	/ERR_CONNECTION_REFUSED at https?:\/\/(?:127\.0\.0\.1|localhost):3847/,
	// Vite + @cloudflare/vite-plugin restarts workerd after a crash. The
	// Playwright webServer process stays up, so later tests fail as ordinary
	// assertion timeouts instead of ECONNREFUSED. Validate #38206666510.
	/The Workers runtime crashed unexpectedly and is being restarted/,
] as const

export function isRetryableE2eFailure(logText: string) {
	const text = stripLogAnsi(logText)
	if (midSuiteWebServerDeathPatterns.some((pattern) => pattern.test(text))) {
		return true
	}
	return e2eWebServerStartFailurePattern.test(text)
}

const wranglerDeployRetryMaxAttempts = 4
const wranglerDeployRetryBaseDelayMs = 1_000
export const wranglerD1MigrationsRetryMaxAttempts = 3
export const wranglerD1MigrationsRetryBaseDelayMs = 10_000

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

export function mainDeploy(args = process.argv.slice(2)) {
	const logPath = args[0]
	if (!logPath) {
		console.error(
			'Usage: node tools/ci/retry-classifiers.ts deploy <deploy-log>',
		)
		process.exitCode = 1
		return
	}
	try {
		process.exitCode = isRetryableDeployFailure(readFileSync(logPath, 'utf8'))
			? 0
			: 1
	} catch {
		process.exitCode = 1
	}
}

export function mainE2e(args = process.argv.slice(2)) {
	const logPath = args[0]
	if (!logPath) {
		console.error(
			'Usage: node tools/ci/retry-classifiers.ts e2e <e2e-attempt-log>',
		)
		process.exitCode = 1
		return
	}
	try {
		process.exitCode = isRetryableE2eFailure(readFileSync(logPath, 'utf8'))
			? 0
			: 1
	} catch {
		process.exitCode = 1
	}
}

export function main(args = process.argv.slice(2)) {
	const [mode, ...rest] = args
	if (mode === 'deploy') {
		mainDeploy(rest)
		return
	}
	if (mode === 'e2e') {
		mainE2e(rest)
		return
	}
	console.error(
		'Usage: node tools/ci/retry-classifiers.ts <deploy|e2e> <log-path>',
	)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	main()
}
