import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	consoleError,
	silenceExpectedConsoleErrors,
} from '#worker/test-support/console-spies.ts'
import {
	classifyOriginProductionScriptState,
	inspectOriginProductionScriptState,
	getCloudflareWorkerScriptExists,
	isCloudflareNotFoundError,
	isCloudflareOkNonJsonError,
	originBootstrapConfigPath,
	planOriginPreviewDeploy,
	planOriginProductionDeploy,
	platformOwnedClassNames,
	previewFleetScriptNames,
	productionOriginScriptName,
	productionOriginBootstrapWorkflowName,
	productionPlatformScriptName,
	productionRuntimeScriptName,
	runtimeOwnedClassNames,
	stripOriginBindingsForLocallyOwnedClasses,
	stripOriginCrossScriptClassBindings,
	stripOriginDurableObjectMigrations,
	writeOriginBootstrapWranglerConfig,
	type DurableObjectNamespaceOwnership,
} from './origin-production-deploy-state.ts'

function ownership(
	script: string,
	className: string,
): DurableObjectNamespaceOwnership {
	return { script, className }
}

function transferredOn(script: string, classNames: ReadonlyArray<string>) {
	return classNames.map((className) => ownership(script, className))
}

const platformOn = (script: string) =>
	transferredOn(script, platformOwnedClassNames)
const runtimeOn = (script: string) =>
	transferredOn(script, runtimeOwnedClassNames)
const multipartBoundary =
	'fe71c953c6db05262becd226201515a4e42a8860e6be9669fec682876e63'
const multipartScript = () =>
	new Response(`--${multipartBoundary}`, {
		status: 200,
		headers: {
			'Content-Type': `multipart/form-data; boundary=${multipartBoundary}`,
		},
	})
const namespacesResponse = (result: Array<{ script: string; class: string }>) =>
	Response.json({ success: true, result, result_info: { total_pages: 1 } })
const inspect = (fetcher: typeof fetch) =>
	inspectOriginProductionScriptState({
		accountId: 'acct',
		apiToken: 'token',
		apiBaseUrl: 'https://cf.test',
		fetcher,
	})
const scriptNameOf = (binding: unknown) =>
	(binding as { script_name?: string }).script_name

test('classifies production fleet ownership into fresh, steady, or ambiguous deploy plans', () => {
	const origin = productionOriginScriptName
	const platform = productionPlatformScriptName
	const runtime = productionRuntimeScriptName
	const fresh = {
		originEntry: 'slim',
		runOriginBootstrap: true,
		forcePlatformAndRuntime: true,
	}
	const cases: Array<
		[
			boolean | null,
			Array<DurableObjectNamespaceOwnership>,
			Record<string, unknown>,
		]
	> = [
		// Missing fleet with no namespaces.
		[false, [], { mode: 'fresh', plan: fresh }],
		// Completed transfer.
		[
			true,
			[
				...platformOn(platform),
				...runtimeOn(runtime),
				ownership(origin, 'JobsHost'),
			],
			{
				mode: 'steady',
				plan: {
					originEntry: 'slim',
					runOriginBootstrap: false,
					forcePlatformAndRuntime: false,
				},
			},
		],
		// A missing origin is not fresh when platform already owns a class.
		[
			false,
			[ownership(platform, 'MCP')],
			{
				mode: 'ambiguous',
				plan: {
					originEntry: 'full',
					runOriginBootstrap: false,
					forcePlatformAndRuntime: false,
				},
			},
		],
		// Origin still owns everything and destinations own none: retry fresh.
		[
			true,
			[...platformOn(origin), ...runtimeOn(origin)],
			{
				mode: 'fresh',
				originOwnedTransferredClassNames: [
					...platformOwnedClassNames,
					...runtimeOwnedClassNames,
				],
				plan: fresh,
			},
		],
		// Refuses to slim while origin still owns a transferred class.
		[
			true,
			[
				...platformOn(platform),
				...runtimeOn(runtime),
				ownership(origin, 'Mailbox'),
			],
			{
				mode: 'ambiguous',
				originOwnedTransferredClassNames: ['Mailbox'],
				plan: { originEntry: 'full' },
			},
		],
		// Platform only partially transferred.
		[
			true,
			[ownership(platform, 'MCP'), ...runtimeOn(runtime)],
			{ mode: 'ambiguous' },
		],
		// Unknown origin-script probe is never fresh or steady.
		[null, [], { mode: 'ambiguous', plan: { runOriginBootstrap: false } }],
	]
	expect(
		cases.map(([originScriptExists, namespaces]) => {
			const state = classifyOriginProductionScriptState({
				originScriptExists,
				namespaces,
			})
			return { ...state, plan: planOriginProductionDeploy(state) }
		}),
	).toMatchObject(cases.map(([, , expected]) => expected))

	// Script existence is the fallback only when namespace listing is unavailable.
	const fallback: Array<[boolean, boolean, boolean, string]> = [
		[false, false, false, 'fresh'],
		[true, true, true, 'steady'],
		[true, false, true, 'ambiguous'],
	]
	expect(
		fallback.map(
			([originScriptExists, platformScriptExists, runtimeScriptExists]) =>
				classifyOriginProductionScriptState({
					originScriptExists,
					platformScriptExists,
					runtimeScriptExists,
					namespaces: null,
				}).mode,
		),
	).toEqual(fallback.map(([, , , mode]) => mode))
})

test('classifies a preview fleet by its own script names and always slims unless origin owns classes', () => {
	const scriptNames = previewFleetScriptNames('kody-pr-7')
	// Production-named ownership must be invisible to a preview probe.
	const productionOwnership = [
		...platformOn(productionPlatformScriptName),
		...runtimeOn(productionRuntimeScriptName),
	]
	const destinations = [
		...platformOn(scriptNames.platform),
		...runtimeOn(scriptNames.runtime),
	]
	const classify = (
		originScriptExists: boolean,
		namespaces: Array<DurableObjectNamespaceOwnership>,
	) =>
		classifyOriginProductionScriptState({
			originScriptExists,
			namespaces,
			scriptNames,
		})
	expect(classify(false, productionOwnership).mode).toBe('fresh')
	expect(classify(true, [...productionOwnership, ...destinations]).mode).toBe(
		'steady',
	)

	const freshState = classify(false, [])
	expect(freshState.mode).toBe('fresh')
	expect(planOriginPreviewDeploy(freshState)).toMatchObject({
		mode: 'fresh',
		originEntry: 'slim',
	})

	// A retried preview run (platform/runtime deployed, origin missing):
	// production would keep the full entry, but preview never owns a class on
	// origin, so ambiguity about the destinations does not change the upload.
	const retried = classify(false, destinations)
	expect(retried.mode).toBe('ambiguous')
	expect(planOriginProductionDeploy(retried).originEntry).toBe('full')
	expect(planOriginPreviewDeploy(retried).originEntry).toBe('slim')

	const steady = classify(true, [
		...destinations,
		ownership(scriptNames.origin, 'JobsHost'),
	])
	expect(steady.mode).toBe('steady')
	expect(planOriginPreviewDeploy(steady).originEntry).toBe('slim')

	// Pre-slim previews bootstrapped every class on origin and also created
	// them on platform/runtime, so all three scripts own namespaces.
	const legacy = classify(true, [
		...platformOn(scriptNames.origin),
		...runtimeOn(scriptNames.origin),
		...destinations,
	])
	expect(legacy.mode).toBe('ambiguous')
	const legacyPlan = planOriginPreviewDeploy(legacy)
	expect(legacyPlan.originEntry).toBe('full')
	expect(legacyPlan.reason).toContain('Origin still owns')
	expect(legacyPlan.reason).toContain('MCP')
})

test('stripOriginDurableObjectMigrations removes top-level and env migrations only', () => {
	const migrations = [{ tag: 'v1', new_sqlite_classes: ['MCP'] }]
	const config: Record<string, unknown> = {
		main: './src/production-worker.ts',
		migrations,
		durable_objects: { bindings: [] },
		env: {
			preview: { migrations, vars: { APP_ENV: 'preview' } },
			production: { migrations },
		},
	}
	const base = {
		main: './src/production-worker.ts',
		durable_objects: { bindings: [] },
	}
	expect(
		stripOriginDurableObjectMigrations(structuredClone(config), 'preview'),
	).toEqual({
		...base,
		env: {
			preview: { vars: { APP_ENV: 'preview' } },
			production: { migrations },
		},
	})
	expect(
		stripOriginDurableObjectMigrations(structuredClone(config), 'production'),
	).toEqual({
		...base,
		env: {
			preview: { migrations, vars: { APP_ENV: 'preview' } },
			production: {},
		},
	})
})

test('Cloudflare probe error classifiers match only 200 non-JSON and 404 failures', () => {
	const cases: Array<[(error: unknown) => boolean, string, boolean]> = [
		[
			isCloudflareOkNonJsonError,
			'Malformed Cloudflare response (200) for /workers/scripts/kody-runtime: --boundary',
			true,
		],
		[
			isCloudflareOkNonJsonError,
			'Malformed Cloudflare response (502) for /workers/scripts/kody-runtime: upstream',
			false,
		],
		[
			isCloudflareNotFoundError,
			'Cloudflare API request failed (404): workers.api.error.not_found',
			true,
		],
		[
			isCloudflareNotFoundError,
			'Cloudflare API request failed (500): upstream',
			false,
		],
	]
	expect(
		cases.filter(([fn, message, want]) => fn(new Error(message)) !== want),
	).toEqual([])
})

test('inspectOriginProductionScriptState probes scripts and ownership, failing closed on errors', async () => {
	await expect(
		getCloudflareWorkerScriptExists({
			accountId: 'acct',
			apiToken: 'token',
			scriptName: productionRuntimeScriptName,
			apiBaseUrl: 'https://cf.test',
			fetcher: async () => multipartScript(),
		}),
	).resolves.toBe(true)

	const steady = await inspect(async (input) =>
		String(input).includes('/workers/durable_objects/namespaces')
			? namespacesResponse([
					...platformOwnedClassNames.map((className) => ({
						script: productionPlatformScriptName,
						class: className,
					})),
					...runtimeOwnedClassNames.map((className) => ({
						script: productionRuntimeScriptName,
						class: className,
					})),
				])
			: multipartScript(),
	)
	expect(steady.mode).toBe('steady')

	const missing = await inspect(async (input) =>
		String(input).includes('/workers/durable_objects/namespaces')
			? namespacesResponse([])
			: Response.json(
					{ success: false, errors: [{ code: 10007, message: 'not found' }] },
					{ status: 404 },
				),
	)
	expect(missing.mode).toBe('fresh')

	silenceExpectedConsoleErrors([/^Retrying Cloudflare API GET \/workers\//])
	const failed = await inspect(async () => {
		throw new Error('fetch failed')
	})
	expect(failed.mode).toBe('ambiguous')
	expect(failed.reason).toContain('Cloudflare script probe failed')
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringMatching(/^Retrying Cloudflare API GET \/workers\/scripts\//),
	)
})

test('bootstrap config keeps the full entry and locally owns transferred classes', async () => {
	const tempDir = await mkdtemp(
		path.join(os.tmpdir(), 'kody-origin-bootstrap-'),
	)
	try {
		const generated = {
			main: './src/production-worker.ts',
			env: {
				production: {
					durable_objects: {
						bindings: [
							{
								name: 'MCP_OBJECT',
								class_name: 'MCP',
								script_name: productionPlatformScriptName,
							},
							{
								name: 'STORAGE_RUNNER',
								class_name: 'StorageRunner',
								script_name: productionRuntimeScriptName,
							},
							{
								name: 'UNRELATED',
								class_name: 'Other',
								script_name: 'someone-else',
							},
						],
					},
					workflows: [
						{
							binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
							class_name: 'DynamicCallableWorkflow',
							script_name: productionRuntimeScriptName,
						},
					],
				},
			},
		}
		const outPath = path.join(tempDir, 'bootstrap.json')
		await writeOriginBootstrapWranglerConfig({
			generatedConfig: generated,
			outConfigPath: outPath,
		})
		const written = JSON.parse(await readFile(outPath, 'utf8')) as {
			main: string
			env: {
				production: {
					durable_objects: {
						bindings: Array<{ class_name: string; script_name?: string }>
					}
					workflows: Array<{ name?: string; script_name?: string }>
				}
			}
		}
		expect(written.main).toBe('./src/index.ts')
		expect(
			written.env.production.durable_objects.bindings.map((binding) => [
				binding.class_name,
				binding.script_name,
			]),
		).toEqual([
			['MCP', undefined],
			['StorageRunner', undefined],
			['Other', 'someone-else'],
		])
		expect(written.env.production.workflows[0]?.script_name).toBeUndefined()
		expect(written.env.production.workflows[0]?.name).toBe(
			productionOriginBootstrapWorkflowName,
		)
		// The generated input is not mutated.
		expect(generated.main).toBe('./src/production-worker.ts')
		expect(
			scriptNameOf(generated.env.production.durable_objects.bindings[0]),
		).toBe(productionPlatformScriptName)
	} finally {
		await rm(tempDir, { recursive: true, force: true })
	}
})

test('strip helpers keep transferred destination bindings and no-op without matching script names', () => {
	const config = {
		env: {
			production: {
				durable_objects: {
					bindings: [
						{
							name: 'MCP_OBJECT',
							class_name: 'MCP',
							script_name: productionPlatformScriptName,
						},
						{
							name: 'STORAGE_RUNNER',
							class_name: 'StorageRunner',
							script_name: productionRuntimeScriptName,
						},
					],
				},
				workflows: [
					{
						binding: 'DYNAMIC_CALLABLE_WORKFLOWS',
						name: 'kody-runtime-dynamic-callable-workflows',
						class_name: 'DynamicCallableWorkflow',
						script_name: productionRuntimeScriptName,
					},
				],
			},
		},
	}
	const bindingScripts = () =>
		config.env.production.durable_objects.bindings.map(scriptNameOf)
	stripOriginCrossScriptClassBindings(config, new Set(['other-script']))
	expect(bindingScripts()).toEqual([
		productionPlatformScriptName,
		productionRuntimeScriptName,
	])

	stripOriginBindingsForLocallyOwnedClasses(config, ['StorageRunner'])
	expect(bindingScripts()).toEqual([productionPlatformScriptName, undefined])
	const workflow = config.env.production.workflows[0] as {
		name?: string
		script_name?: string
	}
	expect(workflow.script_name).toBeUndefined()
	expect(workflow.name).toBe(productionOriginBootstrapWorkflowName)
})

test('originBootstrapConfigPath writes beside the generated config and rejects other suffixes', () => {
	expect(
		originBootstrapConfigPath(
			'packages/worker/wrangler-production.generated.json',
		),
	).toBe('packages/worker/wrangler-production-bootstrap.generated.json')
	expect(() =>
		originBootstrapConfigPath('packages/worker/wrangler-production.json'),
	).toThrow(/\.generated\.json/)
})

test('origin bootstrap omits native platform classes instead of creating stray origin namespaces', () => {
	const config = {
		env: {
			production: {
				durable_objects: {
					bindings: [
						{
							name: 'MCP_OBJECT',
							class_name: 'MCP',
							script_name: productionPlatformScriptName,
						},
						{
							name: 'FILE_STORE',
							class_name: 'FileStore',
							script_name: productionPlatformScriptName,
						},
						{
							name: 'EXECUTION_CONTEXT_SESSION',
							class_name: 'ExecutionContextSessionV1',
							script_name: productionPlatformScriptName,
						},
					],
				},
			},
		},
	}
	stripOriginCrossScriptClassBindings(config)
	expect(config.env.production.durable_objects.bindings).toEqual([
		{ name: 'MCP_OBJECT', class_name: 'MCP' },
	])
})
