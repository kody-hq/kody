import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isExecutedDirectly } from './node-runtime.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

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

function upload(
	dir: string,
	label: string,
	input: {
		release: string
		org: string
		project: string
		sentryCliWrapper: string
	},
): void {
	console.log(`sentry-upload-sourcemaps: uploading ${label} from ${dir}`)
	// Auth comes from the inherited SENTRY_AUTH_TOKEN env var (already
	// validated above) rather than --auth-token, so the secret never appears
	// in child process arguments.
	const result = spawnSync(
		process.execPath,
		[
			input.sentryCliWrapper,
			'sourcemaps',
			'upload',
			dir,
			'--release',
			input.release,
			'--org',
			input.org,
			'--project',
			input.project,
			'--validate',
		],
		{ cwd: root, stdio: 'inherit' },
	)
	if (result.status !== 0) {
		throw new Error(
			`sentry-upload-sourcemaps: ${label} upload failed with status ${result.status}`,
		)
	}
}

export function runSentrySourcemapUpload(env: NodeJS.ProcessEnv = process.env) {
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
	for (const { dir, label } of plan.uploads) {
		upload(dir, label, {
			release,
			org,
			project,
			sentryCliWrapper,
		})
	}
	return 0
}

if (isExecutedDirectly(import.meta.url)) {
	process.exit(runSentrySourcemapUpload())
}
