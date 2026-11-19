import { isRecord } from './is-record.ts'

/**
 * Request progress for `api.kody.codes` execute requests. Origin records the
 * run it started; when the edge sees the origin die, it reads that back and
 * names the run in the 503.
 */

/** Edge → origin header (and response header) naming one API request. */
export const apiRequestIdHeader = 'X-Kody-Request-Id'

/** Execute records the run it started, so a 503 after that can name it. */
export const executeRunProgressStep = 'execute_run'

/** Every recorded step. */
export const apiRequestProgressSteps = [executeRunProgressStep] as const

export type ApiRequestProgressStep = (typeof apiRequestProgressSteps)[number]

/**
 * The run an execute request started. `idempotencyKey` is set only when the
 * key already owns the run, so a retry with it cannot start a second one.
 */
export type ExecuteRunProgress = {
	step: typeof executeRunProgressStep
	runId: string
	idempotencyKey: string | null
}

export type ApiRequestProgress = ExecuteRunProgress

export function apiRequestProgressKvKey(
	requestId: string,
	step: ApiRequestProgressStep,
) {
	return `api-request-progress:v1:${requestId}:${step}`
}

/** Short enough for a KV key, and only the characters a ray id or UUID uses. */
export function isApiRequestId(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)
}

function parseExecuteRunProgress(
	value: Record<string, unknown>,
): ExecuteRunProgress | null {
	const runId = typeof value.runId === 'string' ? value.runId.trim() : ''
	if (!runId || runId.length > 128) return null
	const idempotencyKey =
		typeof value.idempotencyKey === 'string' && value.idempotencyKey.trim()
			? value.idempotencyKey.trim()
			: null
	return { step: executeRunProgressStep, runId, idempotencyKey }
}

export function parseApiRequestProgress(
	value: unknown,
): ApiRequestProgress | null {
	if (!isRecord(value)) return null
	if (value.step === executeRunProgressStep) {
		return parseExecuteRunProgress(value)
	}
	return null
}

/**
 * For the edge's 503 when origin died after execute started a run: the run
 * may still be going (or may have finished), so say how to follow it instead
 * of inviting a blind retry that could repeat its side effects.
 */
export function describeStartedExecuteRun(progress: ExecuteRunProgress) {
	const retry = progress.idempotencyKey
		? `Retrying execute with idempotencyKey "${progress.idempotencyKey}" returns this run instead of starting it again.`
		: 'Do not start it again until runGet shows it ended.'
	return (
		`Execute had already started run ${progress.runId}: it may still be ` +
		'running or may have finished. Read its outcome with runGet ' +
		`({ run_id: "${progress.runId}" }, or GET /v1/runs/${progress.runId}). ` +
		retry
	)
}
