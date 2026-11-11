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

const packageCheckProgressStepLabels: Record<PackageCheckProgressStep, string> =
	{
		checks:
			'package checks: the source checks (manifest, lint, typecheck, and the rest)',
		artifact_reuse_scan:
			'package checks: the artifact reuse scan (finding which published bundles are unchanged)',
		artifact_build: 'package checks: the artifact build',
	}

export type ApiRequestProgress = {
	step: PackageCheckProgressStep
	packageName: string | null
	fileCount: number
	totalBytes: number
	maxFiles: number
	maxTotalBytes: number
}

export function apiRequestProgressKvKey(
	requestId: string,
	step: PackageCheckProgressStep,
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

export function parseApiRequestProgress(
	value: unknown,
): ApiRequestProgress | null {
	if (!isRecord(value)) return null
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
export function describeApiRequestProgress(progress: ApiRequestProgress) {
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
