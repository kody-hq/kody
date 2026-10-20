import { appendFileSync, existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export const sentryUploadMaxAttempts = 3
export const sentryUploadBaseDelayMs = 5_000

// Origin production maps come from `vite build` (`dist/server` + `dist/client`).
// Wrangler resolves `--outdir .wrangler/sentry-bundle` against the config
// file's directory, so sibling scripts land under their package (not the
// origin worker path, and not always the repo root).
export const sentryWorkerBundleRelPaths = [
	'dist/server',
	'packages/worker/.wrangler/sentry-bundle',
	'packages/platform-worker/.wrangler/sentry-bundle',
	'packages/runtime-worker/.wrangler/sentry-bundle',
	'packages/jobs-worker/.wrangler/sentry-bundle',
	'packages/highlight-worker/.wrangler/sentry-bundle',
	'.wrangler/sentry-bundle',
] as const

export const sentryClientAssetsRelPath = 'dist/client'

export type SentrySourcemapUpload = {
	dir: string
	label: string
}

export type SentrySourcemapPlan =
	| { ok: true; uploads: Array<SentrySourcemapUpload> }
	| { ok: false; error: string }

export type SentryUploadAttemptResult = {
	status: number | null
	output: string
}

export function hasSourceMaps(dir: string): boolean {
	if (!existsSync(dir)) return false
	try {
		return readdirSync(dir, { recursive: true }).some((entry) =>
			String(entry).endsWith('.map'),
		)
	} catch {
		return false
	}
}

function workerBundleLabel(
	relPath: (typeof sentryWorkerBundleRelPaths)[number],
): string {
	switch (relPath) {
		case 'dist/server':
			return 'origin vite worker bundle'
		case 'packages/worker/.wrangler/sentry-bundle':
			return 'origin wrangler worker bundle'
		case 'packages/platform-worker/.wrangler/sentry-bundle':
			return 'platform worker bundle'
		case 'packages/runtime-worker/.wrangler/sentry-bundle':
			return 'runtime worker bundle'
		case 'packages/jobs-worker/.wrangler/sentry-bundle':
			return 'jobs worker bundle'
		case 'packages/highlight-worker/.wrangler/sentry-bundle':
			return 'highlight worker bundle'
		case '.wrangler/sentry-bundle':
			return 'repo-root wrangler worker bundle'
		default: {
			const _exhaustive: never = relPath
			return _exhaustive
		}
	}
}

export function planSentrySourcemapUploads(input: {
	root: string
}): SentrySourcemapPlan {
	const workerUploads = sentryWorkerBundleRelPaths.flatMap((relPath) => {
		const dir = join(input.root, relPath)
		return hasSourceMaps(dir)
			? [{ dir, label: workerBundleLabel(relPath) }]
			: []
	})
	if (workerUploads.length === 0) {
		const checked = sentryWorkerBundleRelPaths
			.map((relPath) => join(input.root, relPath))
			.join(', ')
		return {
			ok: false,
			error: `sentry-upload-sourcemaps: no worker bundle with source maps found (checked: ${checked}). Origin maps come from \`vite build\` (\`dist/server\`); sibling deploys still use \`--outdir .wrangler/sentry-bundle --upload-source-maps\` next to each worker config.`,
		}
	}

	const clientDir = join(input.root, sentryClientAssetsRelPath)
	const originBuilt = existsSync(join(input.root, 'dist', 'server'))
	if (hasSourceMaps(clientDir)) {
		return {
			ok: true,
			uploads: [...workerUploads, { dir: clientDir, label: 'client assets' }],
		}
	}
	if (originBuilt) {
		return {
			ok: false,
			error:
				'sentry-upload-sourcemaps: no client source maps in dist/client (expected from vite build).',
		}
	}

	return { ok: true, uploads: workerUploads }
}

/**
 * Retry only upstream blips: HTTP 5xx from Sentry and transport timeouts.
 * Auth / validation / missing-release 4xx stay terminal.
 */
export function isRetryableSentryUploadFailure(output: string): boolean {
	if (/http status:\s*4\d\d\b/i.test(output)) return false
	if (/http status:\s*5\d\d\b/i.test(output)) return true
	if (/\b5\d\d\b.*(?:gateway|timeout|unavailable|bad gateway)/i.test(output)) {
		return true
	}
	return (
		/Downstream timeout/i.test(output) ||
		/Gateway Timeout/i.test(output) ||
		/ETIMEDOUT/i.test(output) ||
		/ECONNRESET/i.test(output) ||
		/ENOTFOUND/i.test(output) ||
		/socket hang up/i.test(output) ||
		/network timeout/i.test(output) ||
		/request timed out/i.test(output)
	)
}

export function sentryUploadSoftFailEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = env.SENTRY_UPLOAD_SOFT_FAIL?.trim().toLowerCase()
	return value === '1' || value === 'true' || value === 'yes'
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export async function runSentryCliUpload(input: {
	dir: string
	release: string
	org: string
	project: string
	sentryCliWrapper: string
	cwd?: string
	execPath?: string
	spawnImpl?: typeof spawn
}): Promise<SentryUploadAttemptResult> {
	const spawnImpl = input.spawnImpl ?? spawn
	const chunks: Array<Buffer> = []
	const result = await new Promise<{ status: number | null }>((resolve) => {
		const child = spawnImpl(
			input.execPath ?? process.execPath,
			[
				input.sentryCliWrapper,
				'sourcemaps',
				'upload',
				input.dir,
				'--release',
				input.release,
				'--org',
				input.org,
				'--project',
				input.project,
				'--validate',
			],
			{
				cwd: input.cwd ?? root,
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		child.stdout?.on('data', (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			chunks.push(buffer)
			process.stdout.write(buffer)
		})
		child.stderr?.on('data', (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			chunks.push(buffer)
			process.stderr.write(buffer)
		})
		child.on('error', (error) => {
			chunks.push(Buffer.from(String(error)))
			resolve({ status: 1 })
		})
		child.on('close', (status) => {
			resolve({ status })
		})
	})
	return {
		status: result.status,
		output: Buffer.concat(chunks).toString('utf8'),
	}
}

export async function uploadSentrySourcemapsWithRetry(input: {
	dir: string
	label: string
	release: string
	org: string
	project: string
	sentryCliWrapper: string
	maxAttempts?: number
	baseDelayMs?: number
	sleep?: (ms: number) => Promise<void>
	runAttempt?: () => Promise<SentryUploadAttemptResult>
	onRetry?: (info: {
		attempt: number
		maxAttempts: number
		delayMs: number
		label: string
	}) => void
}): Promise<SentryUploadAttemptResult> {
	const maxAttempts = input.maxAttempts ?? sentryUploadMaxAttempts
	const baseDelayMs = input.baseDelayMs ?? sentryUploadBaseDelayMs
	const wait = input.sleep ?? sleep
	const runAttempt =
		input.runAttempt ??
		(() =>
			runSentryCliUpload({
				dir: input.dir,
				release: input.release,
				org: input.org,
				project: input.project,
				sentryCliWrapper: input.sentryCliWrapper,
			}))

	console.log(
		`sentry-upload-sourcemaps: uploading ${input.label} from ${input.dir}`,
	)
	let lastResult: SentryUploadAttemptResult = { status: 1, output: '' }
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		lastResult = await runAttempt()
		if (lastResult.status === 0) return lastResult
		const retryable = isRetryableSentryUploadFailure(lastResult.output)
		if (attempt === maxAttempts || !retryable) {
			return lastResult
		}
		const delayMs = baseDelayMs * 2 ** (attempt - 1)
		input.onRetry?.({
			attempt,
			maxAttempts,
			delayMs,
			label: input.label,
		})
		console.log(
			`sentry-upload-sourcemaps: retryable upstream failure for ${input.label}; retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts}).`,
		)
		await wait(delayMs)
	}
	return lastResult
}

function appendStepSummary(message: string, env: NodeJS.ProcessEnv) {
	const summaryPath = env.GITHUB_STEP_SUMMARY?.trim()
	if (!summaryPath) return
	appendFileSync(summaryPath, `${message}\n`, 'utf8')
}

export function reportSentryUploadSoftFailure(input: {
	label: string
	status: number | null
	env?: NodeJS.ProcessEnv
}) {
	const env = input.env ?? process.env
	const detail = `Sentry source map upload failed for ${input.label} (exit ${String(input.status)}) after retries. Preview deploy stays green; production uploads remain strict.`
	console.log(`::warning::${detail}`)
	appendStepSummary(`### Sentry source map upload warning\n\n${detail}\n`, env)
}

export async function runSentrySourcemapUpload(
	env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
	const release =
		env.SENTRY_RELEASE?.trim() ||
		env.APP_COMMIT_SHA?.trim() ||
		env.DEPLOY_COMMIT_SHA?.trim()
	const org = env.SENTRY_ORG?.trim()
	const project = env.SENTRY_PROJECT?.trim()
	const authToken = env.SENTRY_AUTH_TOKEN?.trim()

	if (!release || !org || !project || !authToken) {
		console.log(
			'sentry-upload-sourcemaps: skipping (need SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, and SENTRY_RELEASE or APP_COMMIT_SHA)',
		)
		return 0
	}

	const plan = planSentrySourcemapUploads({ root })
	if (!plan.ok) {
		console.error(plan.error)
		return 1
	}

	const sentryCliWrapper = join(
		root,
		'node_modules',
		'@sentry',
		'cli',
		'bin',
		'sentry-cli',
	)
	const softFail = sentryUploadSoftFailEnabled(env)
	for (const { dir, label } of plan.uploads) {
		const result = await uploadSentrySourcemapsWithRetry({
			dir,
			label,
			release,
			org,
			project,
			sentryCliWrapper,
		})
		if (result.status === 0) continue
		const message = `sentry-upload-sourcemaps: ${label} upload failed with status ${String(result.status)}`
		console.error(message)
		if (softFail && isRetryableSentryUploadFailure(result.output)) {
			// Preview deploy already succeeded; exhausted upstream 5xx/timeout
			// retries become a loud warning instead of a red job. Auth/config
			// 4xx and other non-retryable failures stay hard even on preview.
			reportSentryUploadSoftFailure({
				label,
				status: result.status,
				env,
			})
			continue
		}
		throw new Error(message)
	}
	return 0
}

if (isExecutedDirectly(import.meta.url)) {
	process.exit(await runSentrySourcemapUpload())
}
