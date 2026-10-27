import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { envWithNodeHeapFloor, isExecutedDirectly } from './node-runtime.ts'
import {
	envWithoutUnusableNxRemoteCache,
	formatNxRemoteCacheProbe,
	type NxRemoteCacheProbe,
	nxRemoteCacheServerEnv,
	nxRemoteCacheTokenEnv,
	nxRemoteCacheUsable,
	probeNxRemoteCache,
} from './nx-remote-cache-probe.ts'

export { nxRemoteCacheServerEnv }

export type NxRunResult = {
	status: number
	output: string
	errorMessage: string
}

export type NxRun = (
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
) => NxRunResult | Promise<NxRunResult>

export function isNxRemoteCacheTransportFailure(output: string) {
	return (
		output.includes('Failed to send request:') && output.includes('/v1/cache/')
	)
}

/**
 * Nx fails the process when the self-hosted cache rejects the token.
 * `Misconfigured remote cache endpoint` is that error (a 401 whose body is
 * not exactly `text/plain`, or any unexpected status). `NX Unauthorized:` is
 * the same rejection once the 401 body is exactly `text/plain`. A task that
 * merely mentions 401 or "unauthorized" does not match.
 */
function stripNxAnsi(output: string) {
	return output.replace(
		new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g'),
		'',
	)
}

export function isNxRemoteCacheRejected(output: string) {
	const plain = stripNxAnsi(output)
	if (plain.includes('Misconfigured remote cache endpoint:')) return true
	return /(?:^|\n)[ \t]*NX[ \t]+Unauthorized:/.test(plain)
}

/**
 * Nx prints `Failed tasks:` when a task itself failed, or when a
 * post-success remote-cache 404/401 is attributed to that task. The
 * cache-only case still has a `✔ nx run <task>` line. `Tasks stopped
 * before they finished:` means Nx killed work mid-flight (often because
 * the cache aborted the run) and still gets the local retry.
 */
export function nxRunReportedFailedTasks(output: string) {
	return stripNxAnsi(output).includes('Failed tasks:')
}

export function nxFailedTaskNames(output: string) {
	const plain = stripNxAnsi(output)
	const marker = 'Failed tasks:'
	const start = plain.indexOf(marker)
	if (start === -1) return []
	const names: Array<string> = []
	for (const line of plain.slice(start + marker.length).split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		const match = /^-\s+(\S+)/.exec(trimmed)
		const name = match?.[1]
		if (!name) break
		names.push(name)
	}
	return names
}

export function nxTaskPrintedSuccess(output: string, task: string) {
	const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return new RegExp(`✔\\s+nx run\\s+${escaped}\\b`).test(stripNxAnsi(output))
}

/**
 * Nx can print `Failed tasks:` after a task already succeeded, when the
 * remote cache then 404s or 401s. That is not a compiler or assertion
 * failure. A listed task without a success mark stays a real failure.
 */
export function nxFailedTasksAreRemoteCacheOnly(output: string) {
	if (!isNxRemoteCacheDegradableFailure(output)) return false
	if (!nxRunReportedFailedTasks(output)) return false
	const plain = stripNxAnsi(output)
	if (/\berror TS\d+/.test(plain) || plain.includes('AssertionError')) {
		return false
	}
	const names = nxFailedTaskNames(plain)
	return (
		names.length > 0 && names.every((name) => nxTaskPrintedSuccess(plain, name))
	)
}

export function nxRunReportedTaskFailure(output: string) {
	const plain = stripNxAnsi(output)
	return (
		(nxRunReportedFailedTasks(plain) &&
			!nxFailedTasksAreRemoteCacheOnly(plain)) ||
		plain.includes('Tasks stopped before they finished:')
	)
}

export function isNxRemoteCacheDegradableFailure(output: string) {
	return (
		isNxRemoteCacheTransportFailure(output) || isNxRemoteCacheRejected(output)
	)
}

export function nxTasksSucceededDespiteRemoteCacheFailure(output: string) {
	if (!isNxRemoteCacheDegradableFailure(output)) return false
	if (nxFailedTasksAreRemoteCacheOnly(output)) return true
	return (
		output.includes('Successfully ran target') &&
		!nxRunReportedTaskFailure(output)
	)
}

type NxRemoteCacheFailureKind = 'transport' | 'rejected'

function nxRemoteCacheFailureKind(
	output: string,
): NxRemoteCacheFailureKind | null {
	if (isNxRemoteCacheRejected(output)) return 'rejected'
	if (isNxRemoteCacheTransportFailure(output)) return 'transport'
	return null
}

function remoteCacheDegradeMessage(
	kind: NxRemoteCacheFailureKind,
	phase: 'after-success' | 'before-tasks',
) {
	switch (kind) {
		case 'rejected':
			return phase === 'after-success'
				? 'Nx remote cache rejected the token after tasks succeeded; treating the run as successful.'
				: 'Nx remote cache rejected the token before tasks finished; retrying without the remote cache.'
		case 'transport':
			return phase === 'after-success'
				? 'Nx remote cache request failed after tasks succeeded; treating the run as successful.'
				: 'Nx remote cache request failed before tasks finished; retrying without the remote cache.'
		default: {
			const unreachable: never = kind
			return unreachable
		}
	}
}

// Running nx's JS entry with node avoids the Windows `nx.cmd` shim, which
// needs a shell and breaks on checkout paths with spaces.
function resolveNxEntry() {
	const require = createRequire(import.meta.url)
	const packageJsonPath = require.resolve('nx/package.json')
	const { bin } = require(packageJsonPath) as { bin: { nx: string } }
	return join(dirname(packageJsonPath), bin.nx)
}

/**
 * Stream stdout/stderr to the parent and wait for `close` so the last pipe
 * chunks are captured before cache-failure classification.
 */
export function spawnNx(
	args: ReadonlyArray<string>,
	env?: NodeJS.ProcessEnv,
	forwardTo: {
		stdout?: NodeJS.WritableStream
		stderr?: NodeJS.WritableStream
	} = {},
): Promise<NxRunResult> {
	const stdout = forwardTo.stdout ?? process.stdout
	const stderr = forwardTo.stderr ?? process.stderr
	return new Promise((resolve) => {
		const chunks: Array<string> = []
		const child = spawn(process.execPath, [resolveNxEntry(), ...args], {
			env: envWithNodeHeapFloor(env ?? process.env),
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
		function finish(result: NxRunResult) {
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

export function nxCacheSummaryLine(output: string) {
	return /Cache:\s+\S+ hit \([^)]*\)/.exec(output)?.[0] ?? 'Cache: n/a'
}

/**
 * Nx says nothing when the server rejects an upload, so after every run that
 * had the remote cache configured, ask the server whether this token writes
 * and print the answer next to Nx's own hit count. Never changes the status.
 */
export async function reportNxRemoteCache(input: {
	output: string
	env: NodeJS.ProcessEnv
	remote: NxRemoteOutcome
	knownProbe?: NxRemoteCacheProbe | null
	probe?: typeof probeNxRemoteCache
	log: (line: string) => void
}) {
	switch (input.remote) {
		case 'skipped-unusable': {
			if (!input.knownProbe) return
			input.log(
				`${formatNxRemoteCacheProbe(input.knownProbe)} ${nxCacheSummaryLine(input.output)}`,
			)
			return
		}
		case 'tolerated-rejection': {
			const rejectedServer = input.env[nxRemoteCacheServerEnv]
			if (!rejectedServer) return
			input.log(
				`Nx remote cache skipped (${rejectedServer}): the token was rejected after tasks succeeded, so this run was not failed. ${nxCacheSummaryLine(input.output)}`,
			)
			return
		}
		case 'retried-locally':
		case 'used':
			break
		default: {
			const unreachable: never = input.remote
			throw new Error(`Unexpected Nx remote outcome: ${String(unreachable)}`)
		}
	}
	const server = input.env[nxRemoteCacheServerEnv]
	if (!server) return
	if (input.remote === 'retried-locally') {
		input.log(
			`Nx remote cache skipped (${server}): the run that passed retried without the remote cache, so nothing was uploaded. ${nxCacheSummaryLine(input.output)}`,
		)
		return
	}
	// Probe again after a run that used the remote cache. The pre-run result
	// can be stale if the write token is rotated while the tasks are running,
	// and Nx stays silent when a PUT is rejected.
	const probe: NxRemoteCacheProbe = await (input.probe ?? probeNxRemoteCache)({
		server,
		token: input.env[nxRemoteCacheTokenEnv] ?? '',
	})
	input.log(
		`${formatNxRemoteCacheProbe(probe)} ${nxCacheSummaryLine(input.output)}`,
	)
}

export async function runNxWithRemoteCacheFallback(input: {
	args: ReadonlyArray<string>
	env?: NodeJS.ProcessEnv
	run?: NxRun
	probe?: typeof probeNxRemoteCache
	log?: (line: string) => void
}): Promise<NxRunResult> {
	const env = input.env ?? process.env
	const run = input.run ?? spawnNx
	const log =
		input.log ??
		((line) => {
			console.error(line)
		})

	const gated = await gateNxRemoteCache({ env, probe: input.probe })
	const { result, remote } = await runNxOnce({
		...input,
		env: gated.env,
		run,
		log,
	})
	await reportNxRemoteCache({
		output: result.output,
		env: gated.env,
		remote: gated.skipped ? 'skipped-unusable' : remote,
		knownProbe: gated.probeResult,
		probe: input.probe,
		log,
	})
	return result
}

/**
 * Probe before Nx starts. A rejected or unreachable cache is unset so Nx
 * never treats it as a fatal misconfiguration. Read-only tokens stay pointed
 * at the server; the post-run line reports that they cannot upload.
 */
async function gateNxRemoteCache(input: {
	env: NodeJS.ProcessEnv
	probe?: typeof probeNxRemoteCache
}): Promise<{
	env: NodeJS.ProcessEnv
	probeResult: NxRemoteCacheProbe | null
	skipped: boolean
}> {
	const server = input.env[nxRemoteCacheServerEnv]
	if (!server) return { env: input.env, probeResult: null, skipped: false }
	const probeResult = await (input.probe ?? probeNxRemoteCache)({
		server,
		token: input.env[nxRemoteCacheTokenEnv] ?? '',
	})
	if (nxRemoteCacheUsable(probeResult)) {
		return { env: input.env, probeResult, skipped: false }
	}
	return {
		env: envWithoutUnusableNxRemoteCache(input.env, probeResult),
		probeResult,
		skipped: true,
	}
}

/**
 * `used`: the run that produced the result talked to the remote cache (even if
 * a late cache failure was tolerated). `retried-locally`: the result comes
 * from the `--skipRemoteCache` retry, so no probe can speak for its uploads.
 * `skipped-unusable`: the pre-run probe unset the server before Nx started.
 * `tolerated-rejection`: Nx rejected the token after tasks succeeded, and the
 * run was kept successful instead of claiming the cache is enabled.
 */
export type NxRemoteOutcome =
	| 'used'
	| 'retried-locally'
	| 'skipped-unusable'
	| 'tolerated-rejection'

async function runNxOnce(input: {
	args: ReadonlyArray<string>
	env: NodeJS.ProcessEnv
	run: NxRun
	log: (line: string) => void
}): Promise<{ result: NxRunResult; remote: NxRemoteOutcome }> {
	const { env, run, log } = input
	const first = await run(input.args, env)
	if (first.status === 0) return { result: first, remote: 'used' }

	const combined = `${first.output} ${first.errorMessage}`
	const kind = nxRemoteCacheFailureKind(combined)
	if (!kind) {
		return { result: first, remote: 'used' }
	}

	if (nxTasksSucceededDespiteRemoteCacheFailure(combined)) {
		log(remoteCacheDegradeMessage(kind, 'after-success'))
		return {
			result: { ...first, status: 0 },
			remote: kind === 'rejected' ? 'tolerated-rejection' : 'used',
		}
	}

	if (nxRunReportedFailedTasks(combined)) {
		return { result: first, remote: 'used' }
	}

	if (!env[nxRemoteCacheServerEnv]) return { result: first, remote: 'used' }

	log(remoteCacheDegradeMessage(kind, 'before-tasks'))
	const retryEnv = { ...env }
	delete retryEnv[nxRemoteCacheServerEnv]
	const retried = await run([...input.args, '--skipRemoteCache'], retryEnv)
	return { result: retried, remote: 'retried-locally' }
}

if (isExecutedDirectly(import.meta.url)) {
	const result = await runNxWithRemoteCacheFallback({
		args: process.argv.slice(2),
	})
	process.exit(result.status)
}
