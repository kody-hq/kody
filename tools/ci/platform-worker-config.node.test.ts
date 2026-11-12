import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

import { generate } from './platform-worker-config.ts'
import { parseJsonc } from './resource-utils.ts'

const platformBaseConfigPath = 'packages/platform-worker/wrangler.jsonc'

type Entry = Record<string, unknown>
type EnvConfig = {
	name?: string
	workers_dev?: boolean
	durable_objects?: { bindings?: Array<Entry> }
	d1_databases?: Array<Entry>
	analytics_engine_datasets?: Array<Entry>
	queues?: { producers?: Array<Entry> }
	services?: Array<Entry>
	workflows?: Array<Entry>
	send_email?: Array<Entry>
	artifacts?: Array<Entry>
	vars?: Record<string, unknown>
}
type WorkerConfig = {
	name?: string
	env?: Record<string, EnvConfig>
	migrations?: Array<{
		tag?: string
		transferred_classes?: Array<Record<string, unknown>>
	}>
}

function byName(env: EnvConfig | undefined, name: string) {
	return env?.durable_objects?.bindings?.find(
		(binding) => binding.name === name,
	)
}

test('platform worker owns remaining classes and binds runtime DOs cross-script', async () => {
	const config = parseJsonc<WorkerConfig>(
		await readFile(platformBaseConfigPath, 'utf8'),
	)
	expect(config.migrations?.[0]?.transferred_classes).toEqual(
		expect.arrayContaining(
			['MCP', 'UserMeter', 'Mailbox', 'RepoSession'].map((name) => ({
				from: name,
				from_script: 'kody',
				to: name,
			})),
		),
	)
	for (const envName of ['production', 'preview']) {
		const env = config.env?.[envName]
		expect(byName(env, 'FILE_STORE')).toMatchObject({ class_name: 'FileStore' })
		expect(byName(env, 'FILE_STORE')?.script_name).toBeUndefined()
		expect(byName(env, 'MCP_OBJECT')).toMatchObject({ class_name: 'MCP' })
		expect(byName(env, 'MCP_OBJECT')?.script_name).toBeUndefined()
		expect(byName(env, 'STORAGE_RUNNER')).toMatchObject({
			class_name: 'StorageRunner',
			script_name: 'kody-runtime',
		})
		expect(env?.send_email).toEqual([{ name: 'EMAIL' }])
		expect(env?.artifacts?.[0]).toMatchObject({
			binding: 'ARTIFACTS',
			namespace: envName === 'production' ? 'production' : 'preview',
		})
	}
})

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
				doBinding('MCP_OBJECT', 'MCP', 'kody-platform'),
				doBinding('USER_METER', 'UserMeter', 'kody-platform'),
				doBinding('STORAGE_RUNNER', 'StorageRunner', 'kody-runtime'),
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
			'FILE_BLOBS',
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
					? producers('kody', 'PACKAGE_EVENTS_DISPATCH_QUEUE')
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
			'EMAIL_EVENTS',
			'MCP_PROTOCOL_EVENTS',
			'EXECUTE_INTERPRETABLE_EVENTS',
			'MCP_SEARCH_EVENTS',
			'ONBOARDING_FUNNEL_EVENTS',
		].map((binding) => ({
			binding,
			dataset: `kody_${binding.toLowerCase()}_pr`,
		})),
		vars: {
			APP_BASE_URL: 'https://kody-pr-7.example.workers.dev',
			...(envName === 'preview'
				? { ARTIFACTS_NAMESPACE: 'kody-pr-7' }
				: { ARTIFACTS_NAMESPACE: 'production' }),
		},
	}
	return { name: 'kody', env: { [envName]: env } }
}

async function generatePlatform(input: {
	envName: 'preview' | 'production'
	workerPrefix: string
	mainWorkerName: string
}) {
	consoleError.mockImplementation(() => {})
	const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kody-platform-config-'))
	try {
		const mainConfigPath = path.join(tempDir, 'main.generated.json')
		await writeFile(
			mainConfigPath,
			JSON.stringify(buildMainGeneratedConfig(input.envName)),
		)
		const outConfigPath = path.join(tempDir, 'platform.generated.json')
		const bootstrapPath = path.join(
			tempDir,
			'platform-bootstrap.generated.json',
		)
		await generate({
			envName: input.envName,
			mainConfigPath,
			platformWorkerName: `${input.workerPrefix}-platform`,
			runtimeWorkerName: `${input.workerPrefix}-runtime`,
			mainWorkerName: input.mainWorkerName,
			baseConfigPath: platformBaseConfigPath,
			outConfigPath,
			...(input.envName === 'preview'
				? { outPlatformBootstrapConfigPath: bootstrapPath }
				: {}),
		})
		const read = async (filePath: string) =>
			parseJsonc<WorkerConfig>(await readFile(filePath, 'utf8'))
		return {
			platform: await read(outConfigPath),
			patchedMain: await read(mainConfigPath),
			bootstrap:
				input.envName === 'preview' ? await read(bootstrapPath) : undefined,
		}
	} finally {
		await rm(tempDir, { force: true, recursive: true })
	}
}

test('generate rewrites worker names, copies resource ids, and writes a bootstrap config', async () => {
	const { platform, patchedMain, bootstrap } = await generatePlatform({
		envName: 'preview',
		workerPrefix: 'kody-pr-7',
		mainWorkerName: 'kody-pr-7',
	})
	const previewEnv = platform.env?.preview
	expect(platform.name).toBe('kody-pr-7-platform')
	expect(previewEnv?.name).toBe('kody-pr-7-platform')
	expect(previewEnv?.workers_dev).toBe(true)
	expect(byName(previewEnv, 'STORAGE_RUNNER')?.script_name).toBe(
		'kody-pr-7-runtime',
	)
	expect(previewEnv?.d1_databases?.[0]).toMatchObject({
		binding: 'APP_DB',
		database_name: 'kody-pr-7-db',
		database_id: 'd1-app-id',
	})
	expect(
		previewEnv?.analytics_engine_datasets?.filter((entry) =>
			['EXECUTE_INTERPRETABLE_EVENTS', 'MCP_SEARCH_EVENTS'].includes(
				String(entry.binding),
			),
		),
	).toEqual([
		{
			binding: 'EXECUTE_INTERPRETABLE_EVENTS',
			dataset: 'kody_execute_interpretable_events_pr',
		},
		{ binding: 'MCP_SEARCH_EVENTS', dataset: 'kody_mcp_search_events_pr' },
	])
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
	expect(previewEnv?.artifacts?.[0]).toMatchObject({
		binding: 'ARTIFACTS',
		namespace: 'kody-pr-7',
	})
	expect(previewEnv?.vars?.ARTIFACTS_NAMESPACE).toBe('kody-pr-7')
	expect(previewEnv?.workflows?.[0]?.name).toBe(
		'kody-pr-7-runtime-dynamic-callable-workflows',
	)
	expect(previewEnv?.vars?.APP_BASE_URL).toBe(
		'https://kody-pr-7.example.workers.dev',
	)
	expect(byName(patchedMain.env?.preview, 'MCP_OBJECT')?.script_name).toBe(
		'kody-pr-7-platform',
	)

	// The bootstrap variant deploys before the runtime script exists, so
	// it carries no binding that resolves to it; platform-owned classes
	// and every other binding stay intact.
	const bootstrapEnv = bootstrap?.env?.preview
	const bootstrapBindings = bootstrapEnv?.durable_objects?.bindings ?? []
	expect(
		bootstrapBindings.filter(
			(binding) => binding.script_name === 'kody-pr-7-runtime',
		),
	).toEqual([])
	expect(bootstrapBindings.map((binding) => binding.name)).toEqual(
		expect.arrayContaining(['MCP_OBJECT', 'USER_METER', 'REPO_SESSION']),
	)
	expect(bootstrapBindings).not.toContainEqual(
		expect.objectContaining({ name: 'STORAGE_RUNNER' }),
	)
	expect(bootstrapEnv?.workflows).toEqual([])
	expect(bootstrapEnv?.services).toEqual(previewEnv?.services)
})

test('generate rewrites the production transfer from_script to the main worker name', async () => {
	const { platform } = await generatePlatform({
		envName: 'production',
		workerPrefix: 'kody',
		mainWorkerName: 'kody-production',
	})
	expect(platform.env?.production?.name).toBe('kody-platform')
	expect(platform.migrations?.[0]?.tag).toBe('v1')
	expect(
		platform.migrations?.[0]?.transferred_classes?.every(
			(entry) => entry.from_script === 'kody-production',
		),
	).toBe(true)
})
