import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import { generate } from './runtime-worker-config.ts'
import { parseJsonc } from './resource-utils.ts'

const runtimeBaseConfigPath = 'packages/runtime-worker/wrangler.jsonc'

type Entry = Record<string, unknown>
type EnvConfig = {
	name?: string
	durable_objects?: { bindings?: Array<Entry> }
	d1_databases?: Array<Entry>
	analytics_engine_datasets?: Array<Entry>
	queues?: { producers?: Array<Entry> }
	services?: Array<Entry>
	workflows?: Array<Entry>
	routes?: unknown
	workers_dev?: boolean
	vars?: Record<string, unknown>
}
type WorkerConfig = {
	name?: string
	env?: Record<string, EnvConfig>
	migrations?: Array<{ tag?: string; transferred_classes?: unknown }>
}

function byName(env: EnvConfig | undefined, name: string) {
	return env?.durable_objects?.bindings?.find(
		(binding) => binding.name === name,
	)
}

/** `FOO_BAR_QUEUE` produces into `<prefix>-foo-bar`. */
function producers(prefix: string, ...bindings: Array<string>) {
	return bindings.map((binding) => ({
		binding,
		queue: `${prefix}-${binding
			.replace(/_QUEUE$/, '')
			.toLowerCase()
			.replaceAll('_', '-')}`,
	}))
}

function buildMainGeneratedConfig(envName: string) {
	const doBinding = (
		name: string,
		class_name: string,
		script_name: string,
	) => ({
		name,
		class_name,
		script_name,
	})
	const env = {
		durable_objects: {
			bindings: [
				doBinding('USER_METER', 'UserMeter', 'kody-platform'),
				doBinding('MCP_OBJECT', 'MCP', 'kody-platform'),
				doBinding('STORAGE_RUNNER', 'StorageRunner', 'kody-runtime'),
				doBinding('RUN_LOG', 'RunLog', 'kody-runtime'),
			],
		},
		services: [
			{
				binding: 'RUNTIME_WORKER',
				service: 'kody-runtime',
				entrypoint: 'RuntimeWorkerService',
			},
			{ binding: 'JOBS', service: 'kody-pr-7-jobs', entrypoint: 'JobsService' },
		],
		workflows: [
			{
				binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
				name: 'kody-runtime-dynamic-callable-workflows',
				class_name: 'DynamicCallableWorkflow',
				script_name: 'kody-runtime',
			},
		],
		d1_databases: [
			{
				binding: 'APP_DB',
				database_name: 'kody-pr-7-db',
				database_id: 'd1-app-id',
				migrations_dir: './migrations',
			},
			{
				binding: 'AUDIT_DB',
				database_name: 'kody-pr-7-audit-db',
				database_id: 'd1-audit-id',
				migrations_dir: './audit-migrations',
			},
		],
		kv_namespaces: [
			{ binding: 'OAUTH_KV', id: 'kv-oauth-id' },
			{ binding: 'BUNDLE_ARTIFACTS_KV', id: 'kv-bundle-id' },
		],
		r2_buckets: [
			'COMMUNITY_ASSETS',
			'EMAIL_BLOBS',
			'REPO_SESSION_BLOBS',
			'OPERATOR_BACKUPS',
		].map((binding) => ({
			binding,
			bucket_name: `kody-pr-7-${binding.toLowerCase().replaceAll('_', '-')}`,
		})),
		queues: {
			producers: [
				...producers(
					envName === 'production' ? 'kody' : 'kody-pr-7',
					'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
					'COMMUNITY_ACTIVITY_DISPATCH_QUEUE',
					'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE',
					'WEBHOOK_DISPATCH_QUEUE',
				),
				...(envName === 'production'
					? producers(
							'kody',
							'SCHEDULED_DISPATCH_QUEUE',
							'PACKAGE_EVENTS_DISPATCH_QUEUE',
						)
					: []),
			],
		},
		vectorize: [
			{
				binding: 'CAPABILITY_VECTOR_INDEX',
				index_name: 'kody-capabilities-pr-7',
			},
		],
		analytics_engine_datasets: [
			'USAGE_EVENTS',
			'FLAG_EXPOSURES',
			'MCP_PROTOCOL_EVENTS',
			'ONBOARDING_FUNNEL_EVENTS',
		].map((binding) => ({
			binding,
			dataset: `kody_${binding.toLowerCase()}_pr`,
		})),
		vars: {
			APP_BASE_URL: 'https://kody-pr-7.example.workers.dev',
			PACKAGE_APP_BASE_URL: envName === 'production' ? 'https://kody.run' : '',
			...(envName === 'preview'
				? { ARTIFACTS_NAMESPACE: 'kody-pr-7' }
				: { ARTIFACTS_NAMESPACE: 'production' }),
		} as Record<string, unknown>,
	}
	return { name: 'kody', env: { [envName]: env } }
}

async function generateRuntime(input: {
	envName: 'preview' | 'production'
	workerPrefix: string
	mainWorkerName: string
	mainVars?: Record<string, unknown>
	/** Optional base runtime config path; defaults to the committed wrangler. */
	baseConfigPath?: string
	/** When set, copy the committed base and merge these env routes before generate. */
	baseEnvRoutes?: Array<Record<string, unknown>>
}) {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-runtime-config-'))
	try {
		const mainConfig = buildMainGeneratedConfig(input.envName)
		Object.assign(mainConfig.env[input.envName]?.vars ?? {}, input.mainVars)
		const mainConfigPath = path.join(tempDir, 'main.generated.json')
		await writeFile(mainConfigPath, JSON.stringify(mainConfig))
		const outConfigPath = path.join(tempDir, 'runtime.generated.json')
		let baseConfigPath = input.baseConfigPath ?? runtimeBaseConfigPath
		if (input.baseEnvRoutes) {
			const base = parseJsonc<WorkerConfig>(
				await readFile(runtimeBaseConfigPath, 'utf8'),
			)
			const env = base.env?.[input.envName]
			if (!env) {
				throw new Error(`missing env.${input.envName} in runtime base config`)
			}
			env.routes = [
				...(Array.isArray(env.routes) ? env.routes : []),
				...input.baseEnvRoutes,
			]
			baseConfigPath = path.join(tempDir, 'runtime.base.json')
			await writeFile(baseConfigPath, JSON.stringify(base))
		}
		await generate({
			envName: input.envName,
			mainConfigPath,
			runtimeWorkerName: `${input.workerPrefix}-runtime`,
			platformWorkerName: `${input.workerPrefix}-platform`,
			mainWorkerName: input.mainWorkerName,
			baseConfigPath,
			outConfigPath,
		})
		const read = async (filePath: string) =>
			parseJsonc<WorkerConfig>(await readFile(filePath, 'utf8'))
		return {
			runtime: await read(outConfigPath),
			patchedMain: await read(mainConfigPath),
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
}

test('generate rewrites worker names, copies resource ids, and patches the main config', async () => {
	const { runtime, patchedMain } = await generateRuntime({
		envName: 'preview',
		workerPrefix: 'kody-pr-7',
		mainWorkerName: 'kody-pr-7',
	})
	const previewEnv = runtime.env?.preview
	expect(runtime.name).toBe('kody-pr-7-runtime')
	expect(previewEnv?.name).toBe('kody-pr-7-runtime')
	// Cross-script references point at the resolved platform worker name.
	expect(byName(previewEnv, 'USER_METER')?.script_name).toBe(
		'kody-pr-7-platform',
	)
	expect(byName(previewEnv, 'REPO_SESSION_INDEX')).toMatchObject({
		class_name: 'RepoSessionIndex',
		script_name: 'kody-pr-7-platform',
	})
	// Workflow steps with `execution` reach the context's session DO.
	expect(byName(previewEnv, 'EXECUTION_CONTEXT_SESSION')).toMatchObject({
		class_name: 'ExecutionContextSessionV1',
		script_name: 'kody-pr-7-platform',
	})
	// Resource identifiers are copied from the provisioned main config.
	expect(previewEnv?.d1_databases?.[0]).toMatchObject({
		binding: 'APP_DB',
		database_name: 'kody-pr-7-db',
		database_id: 'd1-app-id',
	})
	expect(previewEnv?.queues?.producers?.map((entry) => entry.binding)).toEqual([
		'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
		'COMMUNITY_ACTIVITY_DISPATCH_QUEUE',
		'COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE',
		'WEBHOOK_DISPATCH_QUEUE',
	])
	expect(
		previewEnv?.queues?.producers?.find(
			(entry) => entry.binding === 'PLATFORM_FEEDBACK_DISPATCH_QUEUE',
		),
	).toMatchObject({ queue: 'kody-pr-7-platform-feedback-dispatch' })
	expect(
		previewEnv?.queues?.producers?.find(
			(entry) => entry.binding === 'WEBHOOK_DISPATCH_QUEUE',
		),
	).toMatchObject({ queue: 'kody-pr-7-webhook-dispatch' })
	expect(previewEnv?.vars?.ARTIFACTS_NAMESPACE).toBe('kody-pr-7')
	// The workflow gets a per-worker name.
	expect(previewEnv?.workflows?.[0]?.name).toBe(
		'kody-pr-7-runtime-dynamic-callable-workflows',
	)
	expect(String(previewEnv?.workflows?.[0]?.name).length).toBeLessThanOrEqual(
		64,
	)
	// Preview has no package-app domain, so no routes are published.
	expect(previewEnv?.routes).toBeUndefined()
	// The main worker's resolved vars are merged in.
	expect(previewEnv?.vars?.APP_BASE_URL).toBe(
		'https://kody-pr-7.example.workers.dev',
	)

	// The main config was patched in place to reference the resolved
	// runtime worker name.
	const mainEnv = patchedMain.env?.preview
	expect(mainEnv?.services?.[0]?.service).toBe('kody-pr-7-runtime')
	// The main config keeps every cross-script reference: the origin never
	// owns these classes in preview, so there is no bootstrap variant.
	expect(byName(mainEnv, 'STORAGE_RUNNER')?.script_name).toBe(
		'kody-pr-7-runtime',
	)
	expect(mainEnv?.workflows?.[0]).toMatchObject({
		name: 'kody-pr-7-runtime-dynamic-callable-workflows',
		script_name: 'kody-pr-7-runtime',
	})
})

test('generate truncates long branch preview workflow names to 64 chars', async () => {
	const { runtime, patchedMain } = await generateRuntime({
		envName: 'preview',
		workerPrefix: 'kody-branch-local-execute-parity-0092',
		mainWorkerName: 'kody-branch-local-execute-parity-0092',
	})
	const workflowName = runtime.env?.preview?.workflows?.[0]?.name
	expect(typeof workflowName).toBe('string')
	expect(String(workflowName).length).toBeLessThanOrEqual(64)
	expect(String(workflowName)).toMatch(/-dynamic-callable-workflows$/)
	expect(String(workflowName)).toMatch(
		/-[0-9a-f]{8}-dynamic-callable-workflows$/,
	)
	expect(patchedMain.env?.preview?.workflows?.[0]?.name).toBe(workflowName)
	// Untruncated would be 72 characters and wrangler would reject the config.
	expect(
		'kody-branch-local-execute-parity-0092-runtime-dynamic-callable-workflows'
			.length,
	).toBe(72)
})

const packageAppApexAndWildcardRoutes = [
	{ pattern: 'kody.run/*', zone_name: 'kody.run' },
	{ pattern: '*.kody.run/*', zone_name: 'kody.run' },
]
const packageAppCatchAllRoute = {
	pattern: '*/*',
	zone_name: 'kody.run',
}
const packageAppRoutes = [
	...packageAppApexAndWildcardRoutes,
	packageAppCatchAllRoute,
]

test('generate publishes the package-app custom domain for production', async () => {
	const { runtime } = await generateRuntime({
		envName: 'production',
		workerPrefix: 'kody',
		mainWorkerName: 'kody',
	})
	// Package-app hosts are zone routes, never custom domains: a custom
	// domain in a zone whose route table the deploy also publishes gets
	// detached (deleting its DNS record) when the routes are replaced.
	expect(runtime.env?.production?.routes).toEqual(packageAppRoutes)
	expect(runtime.env?.production?.name).toBe('kody-runtime')
	expect(runtime.env?.production?.workers_dev).toBe(true)
	expect(
		byName(runtime.env?.production, 'EXECUTION_CONTEXT_SESSION'),
	).toMatchObject({
		class_name: 'ExecutionContextSessionV1',
		script_name: 'kody-platform',
	})
	// The storage transfer migration survives generation untouched.
	expect(runtime.migrations?.[0]?.tag).toBe('v1')
	expect(Array.isArray(runtime.migrations?.[0]?.transferred_classes)).toBe(true)
})

test('generate keeps a GitHub PACKAGE_APP_LEGACY_HOSTS overlay on runtime zone routes', async () => {
	// Overlay already applied to the main generated config, the way
	// `writeGeneratedWranglerConfig` does for a non-empty GitHub var.
	const { runtime } = await generateRuntime({
		envName: 'production',
		workerPrefix: 'kody',
		mainWorkerName: 'kody',
		mainVars: {
			PACKAGE_APP_LEGACY_HOSTS: 'legacy-apps.example.org',
			PACKAGE_APP_LEGACY_REDIRECT: 'true',
		},
	})
	expect(runtime.env?.production?.vars).toMatchObject({
		PACKAGE_APP_LEGACY_HOSTS: 'legacy-apps.example.org',
		PACKAGE_APP_LEGACY_REDIRECT: 'true',
	})
	// Catch-all stays on the canonical SaaS zone only — never on a shared
	// legacy zone where unrelated hosts may lack more-specific Worker routes.
	expect(runtime.env?.production?.routes).toEqual([
		...packageAppApexAndWildcardRoutes,
		{ pattern: 'legacy-apps.example.org/*', zone_name: 'example.org' },
		{ pattern: '*.legacy-apps.example.org/*', zone_name: 'example.org' },
		packageAppCatchAllRoute,
	])
})

test('generate preserves a different-zone */* from the runtime base config', async () => {
	const otherZoneCatchAll = { pattern: '*/*', zone_name: 'other.example' }
	const { runtime } = await generateRuntime({
		envName: 'production',
		workerPrefix: 'kody',
		mainWorkerName: 'kody',
		baseEnvRoutes: [otherZoneCatchAll],
	})
	expect(runtime.env?.production?.routes).toEqual([
		otherZoneCatchAll,
		...packageAppRoutes,
	])
})
