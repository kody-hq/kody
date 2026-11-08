import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
	isRetryableD1LockMessage,
} from '@kody-internal/shared/d1-retry.ts'
import { workerEnvFileRelativePath } from './local-d1-persist.ts'

const outputTruncateLimit = 2_000

type WranglerD1Mode = '--local' | '--remote'

export type WranglerD1SpawnInput = {
	execPath: string
	args: ReadonlyArray<string>
	cwd: string
	env: NodeJS.ProcessEnv
}

export type WranglerD1SpawnResult = {
	status: number | null
	stdout: string
	stderr: string
}

type WranglerD1Spawn = (input: WranglerD1SpawnInput) => WranglerD1SpawnResult

/**
 * Target flags for one `wrangler d1` invocation. Callers pin `--local` or
 * `--remote` and pass `--persist-to` / `--config` only when that command
 * uses them.
 */
export type WranglerD1Target = {
	mode: WranglerD1Mode
	config?: string
	persistTo?: string
	cwd?: string
	env?: NodeJS.ProcessEnv
	envFilePath?: string
	spawnImpl?: WranglerD1Spawn
	sleep?: (ms: number) => void
	maxAttempts?: number
}

export function runWranglerD1(
	target: WranglerD1Target,
	d1Arguments: ReadonlyArray<string>,
): WranglerD1SpawnResult {
	const cwd = target.cwd ?? process.cwd()
	const envFilePath = target.envFilePath ?? workerEnvFileRelativePath
	const nodeArguments: Array<string> = []
	if (existsSync(path.resolve(cwd, envFilePath))) {
		nodeArguments.push(`--env-file=${envFilePath}`)
	}
	nodeArguments.push('./wrangler-env.ts', 'd1', ...d1Arguments, target.mode)
	if (target.config) {
		nodeArguments.push('--config', target.config)
	}
	if (target.persistTo) {
		nodeArguments.push('--persist-to', target.persistTo)
	}
	const spawnImpl = target.spawnImpl ?? defaultSpawnWranglerD1
	return spawnImpl({
		execPath: process.execPath,
		args: nodeArguments,
		cwd,
		// Wrangler emits --json results through its logger. A level above
		// "log" (vitest workers sets "warn") silences that JSON on stdout.
		env: { ...(target.env ?? process.env), WRANGLER_LOG: 'log' },
	})
}

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function failedExecuteError(input: {
	sql: string
	result: WranglerD1SpawnResult
}) {
	return new Error(
		`wrangler d1 execute failed (exit ${String(input.result.status)}) for: ${input.sql}\n${truncate(input.result.stdout)}\n${truncate(input.result.stderr)}`,
	)
}

/**
 * `wrangler d1 execute <binding> --json --command <sql>`. Returns the first
 * statement's rows. Non-zero exit, invalid JSON, or a result object that is
 * not `{ results: object[] }` throws.
 *
 * Local Miniflare and remote D1 both emit transient `SQLITE_BUSY` /
 * `database is locked` (including `SQLITE_BUSY_RECOVERY` after a crashed
 * workerd). Retry those with the same backoff as production D1 helpers so
 * e2e migration bookkeeping does not fail a whole Playwright shard.
 */
export function executeWranglerD1(
	input: WranglerD1Target & { binding: string; sql: string },
): Array<Record<string, unknown>> {
	if (!input.binding) {
		throw new Error('wrangler d1 execute requires a binding.')
	}
	if (!input.sql) {
		throw new Error('wrangler d1 execute requires SQL.')
	}
	const maxAttempts = input.maxAttempts ?? d1LockRetryMaxAttempts
	const sleep = input.sleep ?? sleepSync
	let lastError: Error | undefined
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const result = runWranglerD1(input, [
			'execute',
			input.binding,
			'--json',
			'--command',
			input.sql,
		])
		if (result.status === 0) {
			try {
				return readWranglerD1ExecuteRows(result.stdout)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				if (!result.stderr) throw error
				throw new Error(`${message}\n${truncate(result.stderr)}`)
			}
		}
		lastError = failedExecuteError({ sql: input.sql, result })
		// Classify Wrangler stdout/stderr only. The thrown message also
		// repeats the submitted SQL, which must not make a permanent
		// execute failure retryable.
		if (
			!isRetryableD1LockMessage(`${result.stdout}\n${result.stderr}`) ||
			attempt === maxAttempts
		) {
			throw lastError
		}
		sleep(d1LockRetryBaseDelayMs * 2 ** (attempt - 1))
	}
	throw (
		lastError ??
		failedExecuteError({
			sql: input.sql,
			result: { status: 1, stdout: '', stderr: '' },
		})
	)
}

function readWranglerD1ExecuteRows(
	stdout: string,
): Array<Record<string, unknown>> {
	let parsed: unknown
	try {
		parsed = JSON.parse(stdout)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Unexpected wrangler d1 execute --json output: ${message}\n${truncate(stdout)}`,
		)
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error(
			`Unexpected wrangler d1 execute --json output shape.\n${truncate(stdout)}`,
		)
	}
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
			throw new Error(
				`Unexpected wrangler d1 execute --json output shape.\n${truncate(stdout)}`,
			)
		}
		if ((entry as { success?: unknown }).success === false) {
			throw new Error(
				`wrangler d1 execute reported success: false.\n${truncate(stdout)}`,
			)
		}
	}
	const first = parsed[0] as { results?: unknown }
	if (!Array.isArray(first.results)) {
		throw new Error(
			`Unexpected wrangler d1 execute --json output shape.\n${truncate(stdout)}`,
		)
	}
	for (const row of first.results) {
		if (!row || typeof row !== 'object' || Array.isArray(row)) {
			throw new Error(
				`Unexpected wrangler d1 execute --json output shape.\n${truncate(stdout)}`,
			)
		}
	}
	return first.results as Array<Record<string, unknown>>
}

function defaultSpawnWranglerD1(
	input: WranglerD1SpawnInput,
): WranglerD1SpawnResult {
	const result = spawnSync(input.execPath, [...input.args], {
		cwd: input.cwd,
		encoding: 'utf8',
		env: input.env,
		maxBuffer: 16 * 1024 * 1024,
	})
	const stderr = [result.stderr ?? '', result.error?.message ?? '']
		.filter((part) => part.length > 0)
		.join('\n')
	return {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr,
	}
}

function truncate(text: string) {
	if (text.length <= outputTruncateLimit) return text
	return `${text.slice(0, outputTruncateLimit)}\n...(truncated)`
}
