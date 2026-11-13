import { isRecord } from './is-record.ts'

/**
 * Request progress for `api.kody.codes` operations that can run the origin
 * out of CPU time or memory. Origin records the step it is on; when the edge
 * sees the origin die, it reads the last step back and names it in the 503.
 */

/** Edge → origin header (and response header) naming one API request. */
export const apiRequestIdHeader = 'X-Kody-Request-Id'

/** In order: the last one recorded is the step the request was running. */
export const packageCheckProgressSteps = [
	'checks',
	'artifact_reuse_scan',
	'artifact_build',
] as const

export type PackageCheckProgressStep =
	(typeof packageCheckProgressSteps)[number]

/** Execute records the run it started, so a 503 after that can name it. */
export const executeRunProgressStep = 'execute_run'

/**
 * Every recorded step, in read order: the last one recorded is the step the
 * request was running. One request records steps of one kind only.
 */
export const apiRequestProgressSteps = [
	...packageCheckProgressSteps,
	executeRunProgressStep,
] as const

export type ApiRequestProgressStep = (typeof apiRequestProgressSteps)[number]

const packageCheckProgressStepLabels: Record<PackageCheckProgressStep, string> =
	{
		checks:
			'package checks: the source checks (manifest, lint, typecheck, and the rest)',
		artifact_reuse_scan:
			'package checks: the artifact reuse scan (finding which published bundles are unchanged)',
		artifact_build: 'package checks: the artifact build',
	}

export type PackageCheckProgress = {
	step: PackageCheckProgressStep
	packageName: string | null
	fileCount: number
	totalBytes: number
	maxFiles: number
	maxTotalBytes: number
}

/**
 * The run an execute request started. `idempotencyKey` is set only when the
 * key already owns the run, so a retry with it cannot start a second one.
 */
export type ExecuteRunProgress = {
	step: typeof executeRunProgressStep
	runId: string
	idempotencyKey: string | null
}

export type ApiRequestProgress = PackageCheckProgress | ExecuteRunProgress

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

function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
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
	const step = value.step
	if (
		typeof step !== 'string' ||
		!(packageCheckProgressSteps as ReadonlyArray<string>).includes(step) ||
		!isCount(value.fileCount) ||
		!isCount(value.totalBytes) ||
		!isCount(value.maxFiles) ||
		!isCount(value.maxTotalBytes)
	) {
		return null
	}
	const packageName =
		typeof value.packageName === 'string' && value.packageName.trim()
			? value.packageName.trim()
			: null
	return {
		step: step as PackageCheckProgressStep,
		packageName,
		fileCount: value.fileCount,
		totalBytes: value.totalBytes,
		maxFiles: value.maxFiles,
		maxTotalBytes: value.maxTotalBytes,
	}
}

function percentOf(value: number, limit: number) {
	if (limit <= 0) return 0
	const percent = (value / limit) * 100
	return percent < 1 ? Math.round(percent * 10) / 10 : Math.round(percent)
}

function formatMegabytes(bytes: number) {
	return `${(bytes / 1_000_000).toFixed(2)} MB`
}

function formatMebibytes(bytes: number) {
	return `${Math.round(bytes / (1024 * 1024))} MiB`
}

export function packageCheckProgressStepLabel(step: PackageCheckProgressStep) {
	return packageCheckProgressStepLabels[step]
}

/**
 * "during <step> for <package>. The package is X MB in N files ..." for the
 * edge's resource-limit 503.
 */
export function describeApiRequestProgress(progress: PackageCheckProgress) {
	const subject = progress.packageName ?? 'this package'
	return {
		where: ` during ${packageCheckProgressStepLabel(progress.step)} for ${subject}`,
		size:
			`After .kodyignore the package is ${formatMegabytes(progress.totalBytes)} in ` +
			`${progress.fileCount} files: ${percentOf(progress.totalBytes, progress.maxTotalBytes)}% ` +
			`of the ${formatMebibytes(progress.maxTotalBytes)} check size limit and ` +
			`${percentOf(progress.fileCount, progress.maxFiles)}% of the ` +
			`${progress.maxFiles.toLocaleString('en-US')} file limit. The limit it hit ` +
			'is CPU time or memory for one request, which grows with how much ' +
			'source the checks read and build, so a package well under those ' +
			'size limits can still reach it.',
	}
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
