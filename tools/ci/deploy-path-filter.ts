import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Production deploy path classification:
 * - Start/blog/UI handlers → origin; skip platform/runtime/jobs/highlight
 * - Official guide markdown (also bundled into the MCP Durable Object) →
 *   origin + platform; skip runtime/jobs/highlight
 * - Highlight worker or shared highlight types → highlight (plus origin when
 *   origin also imports those types)
 * - Push queue worker → push-queue; shared receive-pack wait/queue protocol
 *   modules → push-queue + origin (both import them)
 * - Jobs worker or shared jobs modules → jobs (plus origin when origin also
 *   imports those modules)
 * - Fleet-shared helpers (`d1-retry`, `chat` context types) → origin +
 *   platform + runtime + jobs; platform MCP imports those too
 * - `api.kody.codes` edge / `api-docs.kody.codes` docs worker, backup/DR
 *   control plane, contributing docs, and usage docs → no app workers (those
 *   workers have their own workflow jobs)
 * - Shared backup modules → origin (origin parses full backup manifests)
 * - MCP sources, shared app modules, the deploy workflow, and unknown app
 *   sources → origin + platform + runtime. Jobs/highlight only when their
 *   sources or shared deps change.
 *
 * Empty path lists still deploy all six (workflow_dispatch / safety).
 * `.github/workflows/deploy.yml` does **not** force jobs/highlight/push-queue: a
 * runtime-token or secret-wiring edit must not 10000 those siblings and
 * block origin.
 */

const originOnlyPathPrefixes = [
	'packages/worker/client/',
	'packages/worker/start/',
	'packages/worker/public/',
	'packages/worker/src/app/client-entry-assets',
	'packages/worker/src/blog/posts/',
	'packages/worker/src/app/handlers/',
	'packages/worker/src/app/ssr-stubs/',
	'packages/worker/src/origin-handler',
	'packages/worker/universal/styles/',
	'packages/shared/src/backup-',
] as const

const originAndPlatformPathPrefixes = [
	'docs/guides/',
	'packages/worker/src/guides/',
] as const

const originOnlyExactPaths = new Set([
	'packages/worker/universal/blog-display.ts',
	'vite.config.ts',
	'tools/deploy.ts',
	'tools/origin-worker-config.ts',
])

// Origin still handles package-app origin isolation and inline serving
// before the runtime forward (see packages/worker/src/index.ts). Those
// files, plus shared host checks, also run on platform/runtime.
const originOnlyPathExclusions = new Set([
	'packages/worker/src/app/handlers/package-app.ts',
])

const highlightWorkerPathPrefix = 'packages/highlight-worker/'
const highlightSharedPathPrefixes = [
	'packages/worker/universal/highlight-',
	'packages/worker/universal/highlighted-code',
] as const

const pushQueueWorkerPathPrefix = 'packages/push-queue-worker/'
const pushQueueSharedExactPaths = new Set([
	'packages/shared/src/artifacts-receive-pack-wait.ts',
	'packages/shared/src/repo-push-queue-protocol.ts',
])

const jobsWorkerPathPrefix = 'packages/jobs-worker/'
const jobsWorkerResourcesPathPrefix = 'tools/ci/jobs-worker-resources'
const jobsSharedPathPrefix = 'packages/shared/src/jobs/'

// Shared helpers imported by origin, platform MCP, runtime, and jobs.
// Classifying these as jobs-only would skip platform on a retry/context fix.
const fleetSharedExactPaths = new Set([
	'packages/shared/src/d1-retry.ts',
	'packages/shared/src/chat.ts',
])

const platformPathPrefixes = [
	'packages/platform-worker/',
	'packages/worker/src/platform-worker',
	'packages/shared/src/platform-worker',
	'tools/ci/platform-worker-config',
] as const

const runtimePathPrefixes = [
	'packages/runtime-worker/',
	'packages/worker/src/runtime-worker',
	'packages/shared/src/runtime-worker',
	'tools/ci/runtime-worker-config',
] as const

const skipAppWorkerPathPrefixes = [
	'packages/api-worker/',
	'packages/api-docs-worker/',
	'packages/backup-control-plane/',
	'tools/disaster-recovery/',
	'tools/ci/backup-resources',
	'docs/contributing/',
	'docs/use/',
] as const

export type ProductionDeployTargets = {
	deployMain: boolean
	deployPlatform: boolean
	deployRuntime: boolean
	deployJobs: boolean
	deployHighlight: boolean
	deployPushQueue: boolean
}

type DeployScript =
	| 'origin'
	| 'platform'
	| 'runtime'
	| 'jobs'
	| 'highlight'
	| 'push-queue'

type PathClass =
	| { kind: 'skip' }
	| { kind: 'unknown' }
	| { kind: 'scripts'; scripts: ReadonlyArray<DeployScript> }

const allWorkers = {
	deployMain: true,
	deployPlatform: true,
	deployRuntime: true,
	deployJobs: true,
	deployHighlight: true,
	deployPushQueue: true,
} as const satisfies ProductionDeployTargets

const noWorkers = {
	deployMain: false,
	deployPlatform: false,
	deployRuntime: false,
	deployJobs: false,
	deployHighlight: false,
	deployPushQueue: false,
} as const satisfies ProductionDeployTargets

const unknownFallback = {
	deployMain: true,
	deployPlatform: true,
	deployRuntime: true,
	deployJobs: false,
	deployHighlight: false,
	deployPushQueue: false,
} as const satisfies ProductionDeployTargets

function startsWithAny(path: string, prefixes: ReadonlyArray<string>): boolean {
	return prefixes.some((prefix) => path.startsWith(prefix))
}

export function isOriginOnlyPath(path: string) {
	if (originOnlyPathExclusions.has(path)) return false
	if (originOnlyExactPaths.has(path)) return true
	return startsWithAny(path, originOnlyPathPrefixes)
}

export function isOriginAndPlatformPath(path: string) {
	return startsWithAny(path, originAndPlatformPathPrefixes)
}

export function isHighlightWorkerPath(path: string) {
	return path.startsWith(highlightWorkerPathPrefix)
}

export function isHighlightSharedPath(path: string) {
	return startsWithAny(path, highlightSharedPathPrefixes)
}

export function isPushQueueWorkerPath(path: string) {
	return path.startsWith(pushQueueWorkerPathPrefix)
}

export function isPushQueueSharedPath(path: string) {
	return pushQueueSharedExactPaths.has(path)
}

export function isJobsWorkerPath(path: string) {
	return (
		path.startsWith(jobsWorkerPathPrefix) ||
		path.startsWith(jobsWorkerResourcesPathPrefix)
	)
}

export function isJobsSharedPath(path: string) {
	return path.startsWith(jobsSharedPathPrefix)
}

export function isFleetSharedPath(path: string) {
	return fleetSharedExactPaths.has(path)
}

export function isPlatformPath(path: string) {
	return startsWithAny(path, platformPathPrefixes)
}

export function isRuntimePath(path: string) {
	return startsWithAny(path, runtimePathPrefixes)
}

export function isSkipAppWorkerPath(path: string) {
	if (isOriginAndPlatformPath(path)) return false
	return startsWithAny(path, skipAppWorkerPathPrefixes)
}

function classifyPath(path: string): PathClass {
	if (isSkipAppWorkerPath(path)) return { kind: 'skip' }

	const scripts = new Set<DeployScript>()
	if (isHighlightWorkerPath(path) || isHighlightSharedPath(path)) {
		scripts.add('highlight')
	}
	if (isPushQueueWorkerPath(path) || isPushQueueSharedPath(path)) {
		scripts.add('push-queue')
	}
	if (
		isJobsWorkerPath(path) ||
		isJobsSharedPath(path) ||
		isFleetSharedPath(path)
	) {
		scripts.add('jobs')
	}
	if (
		isPlatformPath(path) ||
		isOriginAndPlatformPath(path) ||
		isFleetSharedPath(path)
	) {
		scripts.add('platform')
	}
	if (isRuntimePath(path) || isFleetSharedPath(path)) {
		scripts.add('runtime')
	}
	if (
		isOriginOnlyPath(path) ||
		isOriginAndPlatformPath(path) ||
		isHighlightSharedPath(path) ||
		isPushQueueSharedPath(path) ||
		isJobsSharedPath(path) ||
		isFleetSharedPath(path)
	) {
		scripts.add('origin')
	}

	if (scripts.size > 0) return { kind: 'scripts', scripts: [...scripts] }
	return { kind: 'unknown' }
}

function targetsFromScripts(
	scripts: ReadonlySet<DeployScript>,
): ProductionDeployTargets {
	return {
		deployMain: scripts.has('origin'),
		deployPlatform: scripts.has('platform'),
		deployRuntime: scripts.has('runtime'),
		deployJobs: scripts.has('jobs'),
		deployHighlight: scripts.has('highlight'),
		deployPushQueue: scripts.has('push-queue'),
	}
}

export function classifyProductionDeployPaths(
	paths: ReadonlyArray<string>,
): ProductionDeployTargets {
	const changed = paths.filter((path) => path.length > 0)
	if (changed.length === 0) return { ...allWorkers }

	const scripts = new Set<DeployScript>()
	let sawUnknown = false
	let sawClassified = false

	for (const path of changed) {
		const classified = classifyPath(path)
		switch (classified.kind) {
			case 'skip':
				break
			case 'unknown':
				sawUnknown = true
				sawClassified = true
				break
			case 'scripts':
				sawClassified = true
				for (const script of classified.scripts) scripts.add(script)
				break
			default: {
				const exhaustive: never = classified
				throw new Error(
					`Unhandled deploy path class: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}

	if (!sawClassified) return { ...noWorkers }
	if (sawUnknown) {
		return {
			...unknownFallback,
			deployJobs: scripts.has('jobs'),
			deployHighlight: scripts.has('highlight'),
			deployPushQueue: scripts.has('push-queue'),
		}
	}
	return targetsFromScripts(scripts)
}

export function formatGitHubDeployOutputs(targets: ProductionDeployTargets) {
	return [
		`deploy_main=${targets.deployMain}`,
		`deploy_platform=${targets.deployPlatform}`,
		`deploy_runtime=${targets.deployRuntime}`,
		`deploy_jobs=${targets.deployJobs}`,
		`deploy_highlight=${targets.deployHighlight}`,
		`deploy_push_queue=${targets.deployPushQueue}`,
	].join('\n')
}

async function readStdinPaths() {
	const chunks: Array<string> = []
	for await (const chunk of process.stdin) {
		chunks.push(String(chunk))
	}
	return chunks
		.join('')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
}

export async function main() {
	const paths = await readStdinPaths()
	process.stdout.write(
		`${formatGitHubDeployOutputs(classifyProductionDeployPaths(paths))}\n`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
