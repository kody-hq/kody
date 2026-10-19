import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { readFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { secretAuthorityArgName } from '#mcp/secrets/secret-authority.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { createPackageStorageAccessDeniedMessage } from '#worker/storage-runner.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as ModuleGraph from './module-graph.ts'
import type * as PublishedBundleArtifacts from './published-bundle-artifacts.ts'
import type * as McpAuthUserContext from '#worker/mcp-auth-user-context.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import type * as Registry from '#mcp/capabilities/registry.ts'
import type * as PackageInvocationsService from '#worker/package-invocations/service.ts'

const packageAppSourceText = await readFile(
	new URL('./package-app.ts', import.meta.url),
	'utf8',
)

function extractGeneratedSource(startMarker: string, endMarker: string) {
	const start = packageAppSourceText.indexOf(startMarker)
	const end = packageAppSourceText.indexOf(endMarker, start)
	if (start < 0 || end < 0) {
		throw new Error(`${startMarker} source was not found.`)
	}
	return packageAppSourceText
		.slice(start, end)
		.replaceAll('\\\\', '\\')
		.replaceAll('\\`', '`')
		.replaceAll('\\${', '${')
}

const kodyProxySource = extractGeneratedSource(
	'function createKodyProxy(runtimeBridge, mcpServerNamesOrLoader) {',
	'\nfunction createRealtimeProxy',
)

function createKodyProxyForTest(
	runtimeBridge: unknown,
	mcpServerNames: Array<string> | (() => Promise<Array<string>>) = [],
) {
	// Host entry defines __kodyReadSecretAuthority at module scope; the extracted
	// createKodyProxy body closes over it, so unit evals must supply a stub.
	const readSecretAuthority = () => {
		const getter = (
			globalThis as unknown as Record<symbol, (() => string | null) | undefined>
		)[Symbol.for('kody.getSecretAuthority')]
		return typeof getter === 'function' ? getter() : ''
	}
	return new Function(
		'runtimeBridge',
		'mcpServerNamesOrLoader',
		'__kodyReadSecretAuthority',
		`${kodyProxySource}; return createKodyProxy(runtimeBridge, mcpServerNamesOrLoader);`,
	)(runtimeBridge, mcpServerNames, readSecretAuthority) as Record<
		string,
		unknown
	>
}

/** Workerd-style: [[OwnPropertyKeys]] then GOPD.value (not plain Get). */
function getViaOwnKeysThenGopd(target: object, name: string): unknown {
	if (!Reflect.ownKeys(target).includes(name)) return undefined
	return Reflect.getOwnPropertyDescriptor(target, name)?.value
}

function createWorkflowsProxyForTest(runtimeBridge: unknown) {
	return new Function(
		'runtimeBridge',
		`${extractGeneratedSource(
			'function createWorkflowsProxy(runtimeBridge) {',
			'\nfunction createAuthenticatedFetchHelper',
		)}; return createWorkflowsProxy(runtimeBridge);`,
	)(runtimeBridge) as { create(input: unknown): Promise<unknown> }
}

function collectQueryParamNamesForTest(url: URL) {
	return new Function(
		'url',
		`${extractGeneratedSource(
			'function collectQueryParamNames(url) {',
			'\n\nfunction isSyntheticPackageAppRequest',
		)}; return collectQueryParamNames(url);`,
	)(url) as Array<string>
}

function createRuntimeRunHelpersForTest() {
	return new Function(
		`${extractGeneratedSource(
			'async function startRuntimeRun(runtimeBridge, input) {',
			'\nfunction resolveRealtimeHandler',
		)}; return { startRuntimeRun, finishRuntimeRun };`,
	)() as {
		startRuntimeRun: (
			runtimeBridge: {
				packageRuntimeRunStart: (input: unknown) => Promise<unknown>
			},
			input: unknown,
		) => Promise<unknown>
		finishRuntimeRun: (
			runtimeBridge: {
				packageRuntimeRunFinish: (input: unknown) => Promise<unknown>
			},
			executionCtx: { waitUntil: (promise: Promise<unknown>) => void },
			input: Record<string, unknown>,
		) => void
	}
}

test('package app run-record finish waits for begin inside waitUntil, not on the response path', async () => {
	const { startRuntimeRun, finishRuntimeRun } = createRuntimeRunHelpersForTest()
	let resolveStart: ((value: { id: string }) => void) | undefined
	const startGate = new Promise<{ id: string }>((resolve) => {
		resolveStart = resolve
	})
	const startCalls: Array<unknown> = []
	const finishCalls: Array<unknown> = []
	const waitUntilTasks: Array<Promise<unknown>> = []
	const runtimeBridge = {
		packageRuntimeRunStart: async (input: unknown) => {
			startCalls.push(input)
			return await startGate
		},
		packageRuntimeRunFinish: async (input: unknown) => {
			finishCalls.push(input)
			return { ok: true }
		},
	}

	const runtimeRun = startRuntimeRun(runtimeBridge, {
		surface: 'app_fetch',
		name: '/',
	})
	finishRuntimeRun(
		runtimeBridge,
		{ waitUntil: (promise) => void waitUntilTasks.push(promise) },
		{ run: runtimeRun, status: 'success', metadata: { httpStatus: 200 } },
	)

	expect(startCalls).toEqual([{ surface: 'app_fetch', name: '/' }])
	expect(finishCalls).toEqual([])
	expect(waitUntilTasks).toHaveLength(1)

	resolveStart?.({ id: 'run-1' })
	await Promise.all(waitUntilTasks)
	expect(finishCalls).toEqual([
		{ run: { id: 'run-1' }, status: 'success', metadata: { httpStatus: 200 } },
	])
})

test('package app kody.mcp supports calls, advertises connected servers, and dedupes ownKeys', async () => {
	const calls: Array<{ name: string; args: unknown }> = []
	const runtimeBridge = {
		callCapability: async (input: { name: string; args: unknown }) => {
			calls.push(input)
			return { ok: true }
		},
	}
	type McpNamespace = Record<
		string,
		{ set_pin: (args: unknown) => Promise<unknown> }
	>

	expect(kodyProxySource).toContain(`'${secretAuthorityArgName}'`)

	const withoutNames = createKodyProxyForTest(runtimeBridge)
	await expect(
		(withoutNames.mcp as McpNamespace)['home']?.set_pin({ pin: '1234' }),
	).resolves.toEqual({ ok: true })
	expect(calls).toEqual([{ name: 'mcp:home:set_pin', args: { pin: '1234' } }])
	expect(() => withoutNames['mcp:home:set_pin']).toThrow(
		'MCP server tool "mcp:home:set_pin" is not available as a flat kody function.',
	)
	expect('mcp' in withoutNames).toBe(true)
	expect(Reflect.ownKeys(withoutNames.mcp as object)).toEqual([])
	expect(getViaOwnKeysThenGopd(withoutNames.mcp as object, 'home')).toBe(
		undefined,
	)
	// Get stays open even when ownKeys is empty (Node destructure uses Get).
	const { home: openGetHome } = withoutNames.mcp as McpNamespace
	if (!openGetHome) throw new Error('Expected open Get for mcp.home.')
	await expect(openGetHome.set_pin({ pin: '9' })).resolves.toEqual({
		ok: true,
	})

	for (const [names, pin] of [
		[['home', 'mediarss'], '2'],
		[['home', 'home', 'mediarss'], '3'],
	] as const) {
		const proxy = createKodyProxyForTest(runtimeBridge, [...names])
		expect(Reflect.ownKeys(proxy.mcp as object)).toEqual(['home', 'mediarss'])
		const advertisedHome = getViaOwnKeysThenGopd(
			proxy.mcp as object,
			'home',
		) as McpNamespace[string]
		expect(advertisedHome).toBeTypeOf('object')
		await expect(advertisedHome.set_pin({ pin })).resolves.toEqual({
			ok: true,
		})
	}

	expect(calls).toEqual(
		['1234', '9', '2', '3'].map((pin) => ({
			name: 'mcp:home:set_pin',
			args: { pin },
		})),
	)

	const authoritySymbol = Symbol.for('kody.getSecretAuthority')
	Object.defineProperty(globalThis, authoritySymbol, {
		value: () => 'pkg-stamped',
		configurable: true,
		writable: true,
	})
	try {
		await openGetHome.set_pin({
			pin: '4',
			[secretAuthorityArgName]: 'pkg-forged',
		})
		expect(calls.at(-1)).toEqual({
			name: 'mcp:home:set_pin',
			args: { pin: '4', [secretAuthorityArgName]: 'pkg-stamped' },
		})
	} finally {
		delete (globalThis as unknown as Record<symbol, unknown>)[authoritySymbol]
	}
})

test('package app kody.mcp loads server names lazily on first mcp touch', async () => {
	let loadCount = 0
	const runtimeBridge = {
		callCapability: async () => ({ ok: true }),
	}
	const proxy = createKodyProxyForTest(runtimeBridge, async () => {
		loadCount += 1
		return ['home']
	})

	expect(loadCount).toBe(0)
	await expect(
		(
			proxy.mcp as Record<
				string,
				{ set_pin: (args: unknown) => Promise<unknown> }
			>
		).home?.set_pin({ pin: '1' }),
	).resolves.toEqual({ ok: true })
	expect(loadCount).toBe(1)

	await Promise.resolve()
	await Promise.resolve()
	expect(Reflect.ownKeys(proxy.mcp as object)).toEqual(['home'])
	expect(loadCount).toBe(1)

	const advertised = getViaOwnKeysThenGopd(proxy.mcp as object, 'home') as {
		set_pin: (args: unknown) => Promise<unknown>
	}
	expect(advertised).toBeTypeOf('object')
	await expect(advertised.set_pin({ pin: '2' })).resolves.toEqual({ ok: true })
	expect(loadCount).toBe(1)
})

test('modulesReferenceKodyMcp detects authored kody.mcp access', async () => {
	const { modulesReferenceKodyMcp } =
		await import('./package-app-mcp-preload.ts')
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'export default { async fetch() { return new Response("ok") } }',
		}),
	).toBe(false)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody } from "kody:runtime"\nexport default { async fetch() { return kody.mcp.home.ping({}) } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody } from "kody:runtime"\nconst home = kody["mcp"].home\nexport default home',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody as api } from "kody:runtime"\nexport default { async fetch() { const { home } = api.mcp; return home } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody as api } from "../.__kody_virtual__/public-runtime.js"\nexport default { async fetch() { const { home } = api.mcp; return home } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody as api } from "../.__kody_virtual__/package-runtime/abc.js"\nexport default { async fetch() { return api.mcp.home.ping({}) } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody as api } from "kody:runtime"\nexport default { async fetch() { return new Response(api.metaGetCurrentUser ? "ok" : "no") } }',
		}),
	).toBe(false)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'import { kody as api } from "../.__kody_virtual__/public-runtime.js"\nexport default { async fetch() { return new Response("ok") } }',
		}),
	).toBe(false)
	expect(
		modulesReferenceKodyMcp({
			'entry.cjs':
				'const { kody: api } = require("../.__kody_virtual__/public-runtime.js")\nmodule.exports = { async fetch() { const { home } = api.mcp; return home } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'entry.js':
				'export default { async fetch() { const { kody: api } = await import("../.__kody_virtual__/public-runtime.js"); return api.mcp.home.ping({}) } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'runtime.js':
				'export { kody } from "../.__kody_virtual__/public-runtime.js"',
			'entry.js':
				'import { kody as api } from "./runtime.js"\nexport default { async fetch() { const { home } = api.mcp; return home } }',
		}),
	).toBe(true)
	expect(
		modulesReferenceKodyMcp({
			'runtime.js':
				'export { kody } from "../.__kody_virtual__/public-runtime.js"',
			'entry.js':
				'import { kody as api } from "./runtime.js"\nexport default { async fetch() { return new Response(api.metaGetCurrentUser ? "ok" : "no") } }',
		}),
	).toBe(false)
})

test('package app workflows proxy validates input and forwards to the runtime bridge', async () => {
	const workflows = createWorkflowsProxyForTest({
		workflowCreate: async (input: unknown) => input,
	})
	const runAt = '2026-05-03T12:00:00.000Z'
	const code = 'export default async function main() { return { ok: true } }'
	const oneOf = 'workflows.create requires exactly one of exportName or code.'
	const badRunAt =
		'workflows.create requires a valid runAt ISO-8601 date-time string or Date.'
	const event = { workflowName: 'shade-event', exportName: './run-event' }

	const rejected: Array<[unknown, string]> = [
		[undefined, 'workflows.create requires a workflow input object.'],
		[{}, oneOf],
		[{ exportName: './run-event', code, runAt, idempotencyKey: 'k' }, oneOf],
		[{ ...event, runAt: 'not-a-date', idempotencyKey: 'k' }, badRunAt],
		[
			{ ...event, runAt: 'May 3, 2026 12:00:00', idempotencyKey: 'k' },
			badRunAt,
		],
	]
	for (const [input, message] of rejected) {
		await expect(workflows.create(input)).rejects.toThrow(message)
	}

	const params = { eventId: 'event-1' }
	const accepted: Array<[Record<string, unknown>, Record<string, unknown>]> = [
		[
			{ exportName: './run-event', code: '', runAt, idempotencyKey: 'k' },
			{
				exportName: './run-event',
				runAt: new Date(runAt),
				idempotencyKey: 'k',
			},
		],
		[{ exportName: './run-event', code: '' }, { exportName: './run-event' }],
		[
			{ code, runAt, idempotencyKey: 'k', params },
			{ code, runAt: new Date(runAt), idempotencyKey: 'k', params },
		],
		[
			{ code, params },
			{ code, params },
		],
		[
			{ ...event, workflowName: ' shade-event ', runAt, params },
			{
				...event,
				workflowName: ' shade-event ',
				runAt: new Date(runAt),
				params,
			},
		],
	]
	for (const [input, expected] of accepted) {
		await expect(workflows.create(input)).resolves.toEqual(expected)
	}
})

const packageAppRuntimeMock = vi.hoisted(() => ({
	buildKodyAppBundle: vi.fn(),
	hydrateKodyRuntimeModules: vi.fn<
		typeof ModuleGraph.hydrateKodyRuntimeModules
	>(async ({ modules }) => ({
		modules,
		dynamicDependencyPackageIds: [],
	})),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	assertPublishedSourceCanRebuildWithoutInstallingDeps: vi.fn(),
	getEntitySourceById: vi.fn(),
	packageAppRuntimeBridge: vi.fn((input: unknown) => input),
	resolveCredential: vi.fn(),
	beginRunRecord: vi.fn(),
	finishRunRecord: vi.fn(
		async (
			..._args: Parameters<typeof RunRecordsServiceModule.finishRunRecord>
		) => {},
	),
	getCapabilityRegistryForContext: vi.fn(
		async (
			..._args: Parameters<typeof Registry.getCapabilityRegistryForContext>
		) => ({
			capabilityMap: {},
		}),
	),
	createPackageEventTools: vi.fn(
		async (
			..._args: Parameters<
				typeof PackageInvocationsService.createPackageEventTools
			>
		) => ({
			dispatch: vi.fn(async () => ({})),
		}),
	),
	credentialClientBindingsSeen: [] as Array<string>,
	createCredentialClientKodyTools: vi.fn(
		(input: { options: { binding: string } }) => {
			packageAppRuntimeMock.credentialClientBindingsSeen.push(
				input.options.binding,
			)
			return {
				credentialClientOpen: async () => ({
					ok: true,
					value: {
						handle: 'h-from-props',
						name: 'powersync-jwt',
						scope: 'org',
						kind: 'signing',
						hosts: ['powersync.example'],
					},
				}),
				credentialClientSign: async () => ({
					ok: true,
					value: { signature: 'sig-from-props' },
				}),
			}
		},
	),
}))

vi.mock('#worker/mcp/credential-client-tools.ts', () => ({
	createCredentialClientKodyTools: (...args: Array<unknown>) =>
		packageAppRuntimeMock.createCredentialClientKodyTools(
			...(args as [{ options: { binding: string } }]),
		),
}))

vi.mock('cloudflare:workers', async (importOriginal) => {
	const actual = await importOriginal<typeof CloudflareWorkers>()
	return {
		...actual,
		exports: {
			...actual.exports,
			PackageAppRuntimeBridge: packageAppRuntimeMock.packageAppRuntimeBridge,
		},
	}
})

vi.mock('./module-graph.ts', async () => {
	const actual = await vi.importActual<typeof ModuleGraph>('./module-graph.ts')
	return {
		...actual,
		buildKodyAppBundle: (...args: Array<unknown>) =>
			packageAppRuntimeMock.buildKodyAppBundle(...args),
		hydrateKodyRuntimeModules: (
			...args: Parameters<typeof ModuleGraph.hydrateKodyRuntimeModules>
		) => packageAppRuntimeMock.hydrateKodyRuntimeModules(...args),
	}
})

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifacts>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity(...args),
		persistPublishedBundleArtifact: (...args: Array<unknown>) =>
			packageAppRuntimeMock.persistPublishedBundleArtifact(...args),
	}
})

vi.mock('./published-source-dependencies.ts', () => ({
	assertPublishedSourceCanRebuildWithoutInstallingDeps: (
		...args: Array<unknown>
	) =>
		packageAppRuntimeMock.assertPublishedSourceCanRebuildWithoutInstallingDeps(
			...args,
		),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		packageAppRuntimeMock.getEntitySourceById(...args),
}))

vi.mock('#mcp/secrets/package-access.ts', () => ({
	isPackageSecretAccessUnavailableError: (error: unknown) =>
		error instanceof Error && error.message === 'secret-unavailable',
}))

vi.mock('#worker/credentials/resolve-credential.ts', () => ({
	resolveCredential: (...args: Array<unknown>) =>
		packageAppRuntimeMock.resolveCredential(...args),
}))

vi.mock('#worker/mcp-auth-user-context.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof McpAuthUserContext>()
	return {
		...actual,
	}
})

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (
		...args: Parameters<typeof Registry.getCapabilityRegistryForContext>
	) => packageAppRuntimeMock.getCapabilityRegistryForContext(...args),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	createPackageEventTools: (
		...args: Parameters<
			typeof PackageInvocationsService.createPackageEventTools
		>
	) => packageAppRuntimeMock.createPackageEventTools(...args),
}))

vi.mock('#worker/run-records/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof RunRecordsServiceModule>()
	return {
		...actual,
		beginRunRecord: (...args: Array<unknown>) =>
			packageAppRuntimeMock.beginRunRecord(...args),
		finishRunRecord: (
			...args: Parameters<typeof RunRecordsServiceModule.finishRunRecord>
		) => packageAppRuntimeMock.finishRunRecord(...args),
	}
})

function createPackageAppTestSource() {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package' as const,
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1' as string | null,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-04-30T00:00:00.000Z',
		updated_at: '2026-04-30T00:00:00.000Z',
	}
}

function createPackageAppTestManifest(entry = 'app.js') {
	return {
		name: '@kody/example',
		exports: { '.': `./${entry}` },
		kody: {
			id: 'example',
			description: 'Example package',
			app: {
				entry,
			},
		},
	}
}

function createPackageAppTestEnv() {
	const getEntrypoint = vi.fn(() => ({
		fetch: vi.fn(async () => new Response('ok')),
	}))
	const loader = {
		load: vi.fn(() => ({ getEntrypoint })),
		get: vi.fn(() => ({ getEntrypoint })),
	}
	const appDb = {
		prepare: () => ({ bind: () => ({ first: async () => null }) }),
	}
	const bundleArtifactsKv = { get: async () => null }
	return {
		env: {
			APP_DB: appDb,
			APP_LOADER: loader,
			BUNDLE_ARTIFACTS_KV: bundleArtifactsKv,
		} as unknown as Env,
		loader,
	}
}

function loaderWorkerOptions(loader: { get: ReturnType<typeof vi.fn> }) {
	const factory = loader.get.mock.calls[0]?.[1] as
		| (() => { env: Record<string, unknown>; modules: Record<string, string> })
		| undefined
	return factory?.()
}

function makeArtifact(
	mainSource = 'export default { fetch() { return new Response("ok") } }',
	extra: Record<string, unknown> = {},
) {
	const publishedCommit =
		typeof extra.publishedCommit === 'string'
			? extra.publishedCommit
			: 'commit-1'
	return {
		row: {
			id: 'artifact-row-1',
			artifactName: null,
			entryPoint: 'app.js',
			publishedCommit,
		},
		artifact: {
			mainModule: 'dist/app.js',
			modules: { 'dist/app.js': mainSource },
			dependencies: [],
			dynamicDependencies: [],
			publishedCommit,
			...extra,
		},
	}
}

const freshBundle = {
	mainModule: 'dist/app.js',
	modules: {
		'dist/app.js':
			'export default { fetch() { return new Response("fresh") } }',
	},
	dependencies: [],
	dynamicDependencies: [],
}

function sourceFilesFor(manifest = createPackageAppTestManifest()) {
	const entry = manifest.kody.app.entry
	return async () => ({
		'package.json': JSON.stringify(manifest),
		[entry]: 'export default { async fetch() { return new Response("ok") } }',
	})
}

const {
	buildPackageAppWorker,
	createPackageAppWorkerId,
	PackageAppRuntimeBridge,
} = await import('./package-app.ts')

type BuildInput = Parameters<typeof buildPackageAppWorker>[0]

/** The request of an Owner visiting their own org's app. */
function appVisitorRequest(key: string) {
	const id = `user-${key}`
	return {
		org: { id, slug: key },
		actor: { userId: id, username: key },
		attribution: { kind: 'user', userId: id },
		credential: {
			kind: 'package-app',
			id: null,
			orgId: id,
			scopes: null,
			profileName: null,
		},
		membership: { role: 'owner' },
	}
}

/** `key` keeps user/package ids unique so the in-memory build cache never leaks between tests. */
function makeBuildInput(
	env: Env,
	key: string,
	overrides: Omit<Partial<BuildInput>, 'savedPackage'> & {
		savedPackage?: Partial<BuildInput['savedPackage']>
	} = {},
): BuildInput {
	const { savedPackage, ...rest } = overrides
	return {
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored(`user-${key}`),
		source: createPackageAppTestSource(),
		manifest: createPackageAppTestManifest(),
		runtime: {
			callerContext: {
				user: {
					userId: `user-${key}`,
					email: `${key}@example.com`,
					displayName: `${key} User`,
				},
				request: appVisitorRequest(key),
			},
		} as never,
		...rest,
		savedPackage: {
			id: `package-${key}`,
			kodyId: `example-${key}`,
			name: `@kody/example-${key}`,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			sourceRoot: '/',
			...savedPackage,
		},
	}
}

function createPackageAppRuntimeBridgeForTest(input?: {
	packageStorageGrantIds?: Array<string>
	credentialClientBinding?: string
}) {
	const waitUntilTasks: Array<Promise<unknown>> = []
	const bridge = new PackageAppRuntimeBridge(
		{
			props: {
				baseUrl: 'https://example.com',
				userId: ownerIdFromStored('user-1'),
				orgSlug: 'user',
				visitor: { userId: 'user-1', username: 'user', role: 'owner' },
				email: 'user@example.com',
				displayName: 'User',
				packageId: 'package-1',
				kodyId: 'example',
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				packageStorageGrantIds: input?.packageStorageGrantIds ?? ['package-1'],
				credentialClientBinding:
					input?.credentialClientBinding ?? 'run:test-package-app-binding',
			},
			waitUntil: (promise: Promise<unknown>) => {
				waitUntilTasks.push(promise)
			},
		} as never,
		{} as Env,
	)
	return { bridge, waitUntilTasks }
}

test('buildPackageAppWorker serves an artifactName-null artifact hit and reuses built options with a fresh stub per request', async () => {
	const { env, loader } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(
			'export default { fetch() { return new Response("cached") } }',
		),
	)
	const buildInput = makeBuildInput(env, 'artifact-hit', {
		loadSourceFiles: async () => {
			throw new Error('full source load should be skipped on artifact hit')
		},
	})

	await buildPackageAppWorker(buildInput)
	await buildPackageAppWorker(buildInput)

	// The expensive build (artifact lookup + hydration) runs once; each request
	// still re-acquires a request-bound stub with the same stable worker id.
	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)
	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('user-artifact-hit'),
		sourceId: 'source-1',
		kind: 'app',
		artifactName: null,
		entryPoint: 'app.js',
	})
	expect(packageAppRuntimeMock.buildKodyAppBundle).not.toHaveBeenCalled()
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).not.toHaveBeenCalled()
	expect(loader.get).toHaveBeenCalledTimes(2)
	expect(loader.load).not.toHaveBeenCalled()
	const [firstWorkerId] = loader.get.mock.calls[0] as unknown as [string]
	const [secondWorkerId] = loader.get.mock.calls[1] as unknown as [string]
	expect(firstWorkerId).toBe(secondWorkerId)
	expect(firstWorkerId).toMatch(/^package-app-/)
	const workerOptions = loaderWorkerOptions(loader)
	expect(workerOptions).toMatchObject(createDynamicWorkerCompatibilityOptions())
	const packageAppHostSource = workerOptions?.modules['package-app-entry.js']
	expect(packageAppHostSource).toContain('packages: null,')
	expect(packageAppHostSource).not.toContain('createPackagesProxy')
	// ADR 0068 credential() must be bound into the package-app ALS runtime
	// (execute already had it; package-app historically omitted it).
	expect(packageAppHostSource).toContain('__kodyCreateCredentialRuntime')
	expect(packageAppHostSource).toContain(
		'credential: credentialRuntime.credential',
	)
	expect(packageAppHostSource).toContain('__kodyCredentialRuntimeFor')
	expect(packageAppHostSource).toContain('credentialClientCall')
	expect(packageAppHostSource).toContain('x-kody-credential-client')
	expect(packageAppHostSource).toContain('Leave x-kody-credential-client alone')
	// Must not statically import runtime.js at entry load: optional exports
	// (credential) freeze from empty ALS and stay undefined forever. Preload
	// inside ALS.run via __kodyEnsureRuntimeLoaded and stamp with the module
	// export (not a forgeable Symbol.for getter).
	expect(packageAppHostSource).not.toMatch(
		/import\s*\{[^}]*__kodyGetSecretAuthority[^}]*\}\s*from/,
	)
	expect(packageAppHostSource).not.toMatch(
		/^import .+ from '\.\/\.__kody_virtual__\/runtime\.js'/m,
	)
	expect(packageAppHostSource).toContain('__kodyEnsureRuntimeLoaded')
	expect(packageAppHostSource).toContain('__kodyReadSecretAuthority')
	expect(packageAppHostSource).toContain(
		'__kodyGetSecretAuthorityFn = runtimeModule.__kodyGetSecretAuthority',
	)
	const bridgeProps = packageAppRuntimeMock.packageAppRuntimeBridge.mock
		.calls[0]?.[0] as { props?: { credentialClientBinding?: string } }
	expect(bridgeProps?.props?.credentialClientBinding).toMatch(/^run:/)
})

test('package app createCredentialRuntime exposes callable credential().sign via the bridge', async () => {
	const { createCredentialClientRuntimeSource, credentialClientToolNames } =
		await import('#worker/mcp/execute-modules/credential-client-source.ts')
	type CredentialClientCallInput = { name: string; args?: unknown }
	type CredentialRuntimeBridge = {
		credentialClientCall: (input: CredentialClientCallInput) => Promise<unknown>
	}
	type CredentialRuntime = {
		credential: ((
			key: string,
		) => Promise<{ sign: (operation: unknown) => Promise<string> }>) & {
			named: (name: string) => Promise<unknown>
		}
		credentials: (key: string) => Promise<unknown>
	}
	const calls: Array<CredentialClientCallInput> = []
	const runtimeBridge: CredentialRuntimeBridge = {
		credentialClientCall: async (input) => {
			calls.push(input)
			if (input.name === credentialClientToolNames.open) {
				return {
					ok: true,
					value: {
						handle: 'h1',
						name: 'powersync-jwt',
						scope: 'org',
						kind: 'signing',
						hosts: ['powersync.example'],
					},
				}
			}
			if (input.name === credentialClientToolNames.sign) {
				return { ok: true, value: { signature: 'signed-jwt' } }
			}
			return {
				ok: false,
				error: {
					code: 'invalid_request',
					message: `unexpected ${input.name}`,
					retryWith: [],
				},
			}
		},
	}
	const createCredentialRuntime = new Function(
		'runtimeBridge',
		'packageId',
		`${createCredentialClientRuntimeSource()}
		${extractGeneratedSource(
			'function createCredentialRuntime(runtimeBridge, packageId) {',
			'\nfunction createRuntime(runtimeBridge, packageContext, mcpServerNamesOrLoader) {',
		)}
		return createCredentialRuntime(runtimeBridge, packageId);`,
	) as (
		bridge: CredentialRuntimeBridge,
		packageId?: string,
	) => CredentialRuntime

	const { credential } = createCredentialRuntime(runtimeBridge)
	expect(typeof credential).toBe('function')
	const client = await credential('powersync-jwt')
	await expect(client.sign({ payload: { sub: 'user-1' } })).resolves.toBe(
		'signed-jwt',
	)
	expect(calls).toEqual([
		{
			name: credentialClientToolNames.open,
			args: { key: 'powersync-jwt' },
		},
		{
			name: credentialClientToolNames.sign,
			args: {
				handle: 'h1',
				host: 'powersync.example',
				operation: { payload: { sub: 'user-1' } },
			},
		},
	])

	calls.length = 0
	const bound = createCredentialRuntime(runtimeBridge, 'pkg-dep')
	await bound.credential('resend')
	expect(calls[0]).toEqual({
		name: credentialClientToolNames.open,
		args: { key: 'resend', packageId: 'pkg-dep' },
	})
})

test('package app runtime bridge credentialClientCall dispatches known tools and rejects unknown ones', async () => {
	const { credentialClientToolNames } =
		await import('#worker/mcp/execute-modules/credential-client-source.ts')
	const { bridge } = createPackageAppRuntimeBridgeForTest()
	const openArgs: Array<unknown> = []
	vi.spyOn(
		bridge as unknown as {
			getCredentialClientTools: () => Promise<
				Record<string, (args: unknown) => Promise<unknown>>
			>
		},
		'getCredentialClientTools',
	).mockResolvedValue({
		[credentialClientToolNames.open]: async (args) => {
			openArgs.push(args)
			return {
				ok: true,
				value: {
					handle: 'h1',
					name: 'powersync-jwt',
					scope: 'org',
					kind: 'signing',
					hosts: ['powersync.example'],
				},
			}
		},
		[credentialClientToolNames.sign]: async () => ({
			ok: true,
			value: { signature: 'sig' },
		}),
	})

	await expect(
		bridge.credentialClientCall({
			name: credentialClientToolNames.open,
			args: { key: 'powersync-jwt' },
		}),
	).resolves.toEqual({
		ok: true,
		value: expect.objectContaining({ handle: 'h1', kind: 'signing' }),
	})
	expect(openArgs).toEqual([{ key: 'powersync-jwt' }])

	await expect(
		bridge.credentialClientCall({ name: 'credentialClientNope', args: {} }),
	).rejects.toThrow('Unknown credential client tool "credentialClientNope".')
})

test('package app credential client binding comes from bridge props so open and sign share it across RPC instances', async () => {
	const sharedBinding = 'run:shared-across-rpc-instances'
	packageAppRuntimeMock.credentialClientBindingsSeen.length = 0
	packageAppRuntimeMock.createCredentialClientKodyTools.mockClear()

	const opener = createPackageAppRuntimeBridgeForTest({
		credentialClientBinding: sharedBinding,
	}).bridge
	const signer = createPackageAppRuntimeBridgeForTest({
		credentialClientBinding: sharedBinding,
	}).bridge

	const { credentialClientToolNames } =
		await import('#worker/mcp/execute-modules/credential-client-source.ts')
	await opener.credentialClientCall({
		name: credentialClientToolNames.open,
		args: { key: 'powersync-jwt' },
	})
	await signer.credentialClientCall({
		name: credentialClientToolNames.sign,
		args: {
			handle: 'h-from-props',
			host: 'powersync.example',
			operation: {},
		},
	})

	expect(packageAppRuntimeMock.credentialClientBindingsSeen).toEqual([
		sharedBinding,
		sharedBinding,
	])
})

test('buildPackageAppWorker claims the unique Dynamic Worker day with its surface off the stub path, only after acquiring the stub', async () => {
	const usageModule = await import('#worker/usage/dynamic-worker-day.ts')
	let resolveClaim: (() => void) | undefined
	const claimGate = new Promise<void>((resolve) => {
		resolveClaim = resolve
	})
	const recordSpy = vi
		.spyOn(usageModule, 'recordUniqueDynamicWorkerDay')
		.mockImplementation(async () => {
			await claimGate
			return undefined
		})
	const waitUntilTasks: Array<Promise<unknown>> = []
	const { env } = createPackageAppTestEnv()
	const failing = createPackageAppTestEnv()
	failing.loader.get.mockImplementation(() => {
		throw new Error('loader-get-failed')
	})
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(),
	)

	try {
		await expect(
			buildPackageAppWorker(
				makeBuildInput(failing.env, 'uwd-fail', { surface: 'app_fetch' }),
			),
		).rejects.toThrow('loader-get-failed')
		expect(recordSpy).not.toHaveBeenCalled()

		const built = await buildPackageAppWorker(
			makeBuildInput(env, 'uwd-surface', {
				surface: 'app_realtime',
				waitUntil: (promise) => void waitUntilTasks.push(promise),
			}),
		)

		expect(built.stub).toBeTruthy()
		expect(recordSpy).toHaveBeenCalledTimes(1)
		expect(recordSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: ownerIdFromStored('user-uwd-surface'),
				surface: 'app_realtime',
				workerId: expect.stringMatching(/^package-app-/),
			}),
		)
		// The deferred usage check and the day claim.
		expect(waitUntilTasks).toHaveLength(2)
		resolveClaim?.()
		await Promise.all(waitUntilTasks)
	} finally {
		recordSpy.mockRestore()
	}
})

test('package app worker exposes its public mount and records fetch query and response status', async () => {
	const { env, loader } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(
			'export default { fetch() { return new Response("ok", { status: 201 }) } }',
		),
	)

	await buildPackageAppWorker(
		makeBuildInput(env, 'public-context', {
			baseUrl: 'https://app.kody.test',
			savedPackage: {
				kodyId: 'renamed-app',
				name: '@current-owner/renamed-app',
			},
			runtime: {
				callerContext: {
					user: { email: 'owner@example.com', displayName: 'Owner' },
					request: appVisitorRequest('owner'),
				} as never,
				servingUsername: 'serving-owner',
				hostedOrigin: 'https://packages.kody.test',
			},
		}),
	)

	expect(loaderWorkerOptions(loader)?.env['__kodyPackageContext']).toEqual({
		packageId: 'package-public-context',
		kodyId: 'renamed-app',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		appBasePath: '/@serving-owner/packages/renamed-app',
		hostedUrl: 'https://packages.kody.test/@serving-owner/packages/renamed-app',
		assetBasePath: '/@serving-owner/packages/renamed-app/_assets',
		clientModuleUrl: null,
	})

	expect(
		collectQueryParamNamesForTest(
			new URL(
				'https://packages.kody.test/callback?audio=1&code=oauth-code-secret&state=oauth-state-secret&audio=2',
			),
		),
	).toEqual(['audio', 'code', 'state'])
})

test('package app public mount uses the name leaf when kodyId diverges', async () => {
	const { env, loader } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact('export default { fetch() { return new Response("ok") } }'),
	)

	await buildPackageAppWorker(
		makeBuildInput(env, 'public-context-leaf', {
			baseUrl: 'https://app.kody.test',
			savedPackage: {
				kodyId: 'legacy-kody-id',
				name: '@current-owner/canonical-leaf',
			},
			runtime: {
				callerContext: {
					user: { email: 'owner@example.com', displayName: 'Owner' },
					request: appVisitorRequest('owner'),
				} as never,
				servingUsername: 'serving-owner',
				hostedOrigin: 'https://packages.kody.test',
			},
		}),
	)

	expect(
		loaderWorkerOptions(loader)?.env['__kodyPackageContext'],
	).toMatchObject({
		kodyId: 'legacy-kody-id',
		appBasePath: '/@serving-owner/packages/canonical-leaf',
		hostedUrl:
			'https://packages.kody.test/@serving-owner/packages/canonical-leaf',
		assetBasePath: '/@serving-owner/packages/canonical-leaf/_assets',
	})
})

test('package app worker exposes the fingerprinted client module URL when kody.app.client is declared', async () => {
	const { env, loader } = createPackageAppTestEnv()
	const appArtifact = makeArtifact()
	const clientArtifact = {
		row: {
			id: 'artifact-row-client',
			artifactName: null,
			entryPoint: 'client.ts',
			publishedCommit: 'commit-1',
		},
		artifact: {
			mainModule: 'client.abcdefgh12345678.js',
			modules: { 'client.abcdefgh12345678.js': 'console.log("hi")' },
			dependencies: [],
			dynamicDependencies: [],
			publishedCommit: 'commit-1',
		},
	}
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string }) =>
			input.kind === 'app-client' ? clientArtifact : appArtifact,
	)
	const baseManifest = createPackageAppTestManifest()

	await buildPackageAppWorker(
		makeBuildInput(env, 'client-context', {
			baseUrl: 'https://app.kody.test',
			savedPackage: { kodyId: 'client-app', name: '@current-owner/client-app' },
			manifest: {
				...baseManifest,
				kody: {
					...baseManifest.kody,
					app: { entry: 'app.js', client: './client.ts' },
				},
			},
			runtime: {
				callerContext: {
					user: { email: 'owner@example.com', displayName: 'Owner' },
					request: appVisitorRequest('owner'),
				} as never,
				servingUsername: 'serving-owner',
				hostedOrigin: 'https://serving-owner.kody.run',
				mount: 'user-subdomain',
			},
		}),
	)

	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: 'app-client',
			artifactName: null,
			entryPoint: 'client.ts',
		}),
	)
	expect(
		loaderWorkerOptions(loader)?.env['__kodyPackageContext'],
	).toMatchObject({
		appBasePath: '/packages/client-app',
		hostedUrl: 'https://serving-owner.kody.run/packages/client-app',
		assetBasePath: '/packages/client-app/_assets',
		clientModuleUrl:
			'https://serving-owner.kody.run/packages/client-app/_assets/client.abcdefgh12345678.js',
	})
})

test('createPackageAppWorkerId changes when compatibility settings change', async () => {
	const cacheKey = JSON.stringify([
		'user-compat-id',
		'package-compat-id',
		'example-compat-id',
		'source-1',
		'commit-1',
		'https://example.com',
		'compat@example.com',
		'Compat User',
	])
	const baseWorkerOptions = {
		...createDynamicWorkerCompatibilityOptions(),
		mainModule: 'package-app-entry.js',
		modules: {
			'package-app-entry.js':
				'export default { fetch() { return new Response("ok") } }',
		},
	}
	const idFor = (overrides: Record<string, unknown> = {}) =>
		createPackageAppWorkerId({
			cacheKey,
			workerOptions: { ...baseWorkerOptions, ...overrides },
		})

	const baselineId = await idFor()
	const dateChangedId = await idFor({ compatibilityDate: '2025-06-01' })
	const flagsChangedId = await idFor({ compatibilityFlags: ['nodejs_compat'] })

	expect(baselineId).toMatch(/^package-app-/)
	expect(await idFor()).toBe(baselineId)
	expect(dateChangedId).not.toBe(baselineId)
	expect(flagsChangedId).not.toBe(baselineId)
	expect(dateChangedId).not.toBe(flagsChangedId)
})

test('buildPackageAppWorker treats a prior-commit identity artifact as a miss while published_commit has advanced', async () => {
	const { env } = createPackageAppTestEnv()
	const freshSource = {
		...createPackageAppTestSource(),
		published_commit: 'commit-2',
	}
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(
			'export default { fetch() { return new Response("stale") } }',
			{ publishedCommit: 'commit-1' },
		),
	)
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue(freshBundle)
	packageAppRuntimeMock.persistPublishedBundleArtifact.mockResolvedValue(
		'bundle-artifact:v1:source-1:commit-2:app:_:app.js',
	)
	packageAppRuntimeMock.getEntitySourceById.mockResolvedValue(freshSource)

	await buildPackageAppWorker(
		makeBuildInput(env, 'stale-commit-artifact', {
			userId: ownerIdFromStored('user-1'),
			savedPackage: { publishedCommit: 'commit-2' },
			source: freshSource,
			loadSourceFiles: sourceFilesFor(),
		}),
	)

	expect(packageAppRuntimeMock.buildKodyAppBundle).toHaveBeenCalledTimes(1)
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			source: freshSource,
			kind: 'app',
		}),
	)
})

test('an app artifact rebuild persists artifactName null using the fresh source row and its entry point', async () => {
	const { env } = createPackageAppTestEnv()
	const freshSource = {
		...createPackageAppTestSource(),
		published_commit: 'commit-2',
	}
	const freshManifest = createPackageAppTestManifest('fresh.js')
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		null,
	)
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue(freshBundle)
	packageAppRuntimeMock.persistPublishedBundleArtifact.mockResolvedValue(
		'bundle-artifact:v1:source-1:commit-2:app:_:fresh.js',
	)
	packageAppRuntimeMock.getEntitySourceById.mockResolvedValue(freshSource)

	await buildPackageAppWorker(
		makeBuildInput(env, 'rebuild-entry', {
			userId: ownerIdFromStored('user-1'),
			manifest: createPackageAppTestManifest('stale.js'),
			loadSourceFiles: sourceFilesFor(freshManifest),
		}),
	)

	expect(packageAppRuntimeMock.getEntitySourceById).toHaveBeenCalledTimes(1)
	expect(packageAppRuntimeMock.buildKodyAppBundle).toHaveBeenCalledTimes(1)
	expect(packageAppRuntimeMock.buildKodyAppBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'fresh.js' }),
	)
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			source: freshSource,
			kind: 'app',
			artifactName: null,
			entryPoint: 'fresh.js',
		}),
	)
})

test('buildPackageAppWorker rejects persisting artifacts for a source owned by another user', async () => {
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		null,
	)
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue(freshBundle)
	// Rebuild always loads the current source row. The lookup finds nothing
	// for this user, so persist must not run.
	packageAppRuntimeMock.getEntitySourceById.mockResolvedValue(null)

	await expect(
		buildPackageAppWorker(
			makeBuildInput(env, 'other', { loadSourceFiles: sourceFilesFor() }),
		),
	).rejects.toThrow('Saved package source "source-1" was not found.')

	expect(packageAppRuntimeMock.getEntitySourceById).toHaveBeenCalledTimes(1)
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).not.toHaveBeenCalled()
})

test('buildPackageAppWorker skips published artifact lookup when publishedCommit is null', async () => {
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { fetch() { return new Response("draft") } }',
		},
		dependencies: [],
	})

	await buildPackageAppWorker(
		makeBuildInput(env, 'unpublished', {
			savedPackage: { publishedCommit: null },
			source: { ...createPackageAppTestSource(), published_commit: null },
			loadSourceFiles: sourceFilesFor(),
		}),
	)

	expect(
		packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	expect(
		packageAppRuntimeMock.persistPublishedBundleArtifact,
	).not.toHaveBeenCalled()
	expect(packageAppRuntimeMock.buildKodyAppBundle).toHaveBeenCalledTimes(1)
})

test('package app runtime bridge returns opaque secret refs and merges metadata via waitUntil', async () => {
	const opaqueRef = '{{secret:apiToken|scope=user}}'
	packageAppRuntimeMock.resolveCredential.mockResolvedValue({
		alias: 'api-token',
		name: 'apiToken',
		ref: opaqueRef,
		scope: 'user',
		packageId: 'package-1',
		kodyId: 'demo',
	})
	let resolveFinish: (() => void) | undefined
	const finishGate = new Promise<void>((resolve) => {
		resolveFinish = resolve
	})
	packageAppRuntimeMock.finishRunRecord.mockImplementation(async () => {
		await finishGate
	})
	const { bridge, waitUntilTasks } = createPackageAppRuntimeBridgeForTest()
	const runHandle = {
		id: 'run-1',
		userId: ownerIdFromStored('user-1'),
		startedAt: '2026-07-26T00:00:00.000Z',
		persistence: 'eager' as const,
		context: {
			surface: 'app_fetch' as const,
			packageId: 'package-1',
			metadata: {
				method: 'GET',
				queryParamNames: ['audio', 'code', 'state'],
			},
		},
	}
	const logs = [
		{ level: 'log' as const, message: `token=${opaqueRef}` },
		`also ${opaqueRef}`,
	]
	const error = { name: 'Error', message: `boom ${opaqueRef}` }

	await expect(
		bridge.packageSecretGet({ alias: 'api-token' }),
	).resolves.toEqual({ value: opaqueRef })

	await expect(
		bridge.packageRuntimeRunFinish({
			run: runHandle,
			status: 'error',
			metadata: { httpStatus: 201 },
			logs,
			error,
		}),
	).resolves.toEqual({ ok: true })

	// Finish is scheduled on waitUntil; the HTTP/RPC path must not await it.
	expect(waitUntilTasks).toHaveLength(1)
	expect(packageAppRuntimeMock.finishRunRecord).toHaveBeenCalledTimes(1)
	resolveFinish?.()
	await Promise.all(waitUntilTasks)

	expect(packageAppRuntimeMock.finishRunRecord).toHaveBeenCalledWith({
		env: {},
		handle: {
			...runHandle,
			context: {
				...runHandle.context,
				metadata: {
					method: 'GET',
					queryParamNames: ['audio', 'code', 'state'],
					httpStatus: 201,
				},
			},
		},
		status: 'error',
		logs,
		error,
	})
})

test('package app secret mounts ignore author-selected packageId and honor the stamp field', async () => {
	const ref = '{{secret:apiToken|scope=user}}'
	packageAppRuntimeMock.resolveCredential.mockResolvedValue({
		alias: 'api-token',
		name: 'apiToken',
		ref,
		scope: 'user',
		packageId: 'package-1',
		kodyId: 'demo',
	})
	const { bridge } = createPackageAppRuntimeBridgeForTest({
		packageStorageGrantIds: ['package-1', 'pkg-a'],
	})
	const cases: Array<
		[{ alias: string; packageId: string; [key: string]: string }, string]
	> = [
		[{ alias: 'api-token', packageId: 'pkg-a' }, 'package-1'],
		[
			{
				alias: 'api-token',
				packageId: 'package-1',
				[secretAuthorityArgName]: 'pkg-a',
			},
			'pkg-a',
		],
	]
	for (const [input, resolvedPackageId] of cases) {
		packageAppRuntimeMock.resolveCredential.mockClear()
		await expect(bridge.packageSecretGet(input)).resolves.toEqual({
			value: ref,
		})
		expect(packageAppRuntimeMock.resolveCredential).toHaveBeenCalledWith(
			expect.objectContaining({
				packageStamp: { kind: 'attested', packageId: resolvedPackageId },
				credential: expect.objectContaining({
					use: 'package-secret-mount',
					alias: 'api-token',
				}),
			}),
		)
	}
})

test('package app runtime bridge enforces packageStorage grants and raw storage namespace ACLs', async () => {
	const { bridge } = createPackageAppRuntimeBridgeForTest({
		packageStorageGrantIds: ['package-1', 'dep-package'],
	})
	const getValue = vi.fn(async () => ({ value: 'granted-value' }))
	const setValue = vi.fn(async () => ({ ok: true }))
	const getStorageRunner = vi
		.spyOn(
			bridge as unknown as {
				getStorageRunner: (storageId: string) => unknown
			},
			'getStorageRunner',
		)
		.mockImplementation((storageId: string) => ({
			storageId,
			getValue,
			setValue,
			listValues: vi.fn(),
			sqlQuery: vi.fn(),
			deleteValue: vi.fn(),
			clearStorage: vi.fn(),
		}))
	vi.spyOn(
		bridge as unknown as {
			assertStorageWriteAllowed: (input: unknown) => Promise<void>
		},
		'assertStorageWriteAllowed',
	).mockResolvedValue(undefined)

	await expect(
		bridge.packageStorageGet({ packageId: 'package-1', key: 'count' }),
	).resolves.toEqual({ value: 'granted-value' })
	expect(getStorageRunner).toHaveBeenCalledWith(
		buildPackageStorageId('package-1'),
	)
	expect(getValue).toHaveBeenCalledWith({ key: 'count' })

	await expect(
		bridge.packageStorageSet({
			packageId: 'dep-package',
			key: 'flag',
			value: true,
		}),
	).resolves.toEqual({ ok: true })
	expect(getStorageRunner).toHaveBeenCalledWith(
		buildPackageStorageId('dep-package'),
	)
	expect(setValue).toHaveBeenCalledWith({ key: 'flag', value: true })

	await expect(
		bridge.packageStorageGet({ packageId: 'victim-package', key: 'secret' }),
	).rejects.toThrow(createPackageStorageAccessDeniedMessage('victim-package'))
	expect(getValue).toHaveBeenCalledTimes(2)

	await expect(
		bridge.packageStorageClear({ packageId: '   ' }),
	).rejects.toThrow('packageStorage requires a non-empty package id.')

	getValue.mockClear()
	setValue.mockClear()
	getStorageRunner.mockClear()

	await expect(
		bridge.storageGet({ storageId: 'package-1:facet:main', key: 'facet' }),
	).resolves.toEqual({ value: 'granted-value' })
	await expect(
		bridge.storageSet({
			storageId: 'package-1:Counter:instance-a',
			key: 'n',
			value: 1,
		}),
	).resolves.toEqual({ ok: true })
	expect(getStorageRunner).toHaveBeenCalledWith('package-1:facet:main')
	expect(getStorageRunner).toHaveBeenCalledWith('package-1:Counter:instance-a')

	const outsideNamespaceError =
		/outside this app's namespace[\s\S]*packageStorage\(\)/
	for (const storageId of [
		'package-1',
		buildPackageStorageId('victim-package'),
		'other-package',
	]) {
		await expect(bridge.storageGet({ storageId, key: 'x' })).rejects.toThrow(
			outsideNamespaceError,
		)
	}
	await expect(
		bridge.storageSet({ storageId: 'job:nightly', key: 'state', value: true }),
	).rejects.toThrow(outsideNamespaceError)
	await expect(
		bridge.storageGet({ storageId: '   ', key: 'x' }),
	).rejects.toThrow('Package app storage requires a non-empty storage id.')
	expect(getStorageRunner).toHaveBeenCalledTimes(3)
})

test('buildPackageAppWorker passes packageStorage grant ids from root, static, and dynamic deps', async () => {
	const { env } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(undefined, {
			dependencies: [
				{
					sourceId: 'dep-source',
					publishedCommit: 'dep-commit',
					kodyId: 'dep',
					packageId: 'static-dep-package',
				},
			],
			dynamicDependencies: [
				{
					specifier: 'kody:@scope/dynamic/default',
					packageName: '@scope/dynamic',
					exportName: 'default',
				},
			],
		}),
	)
	packageAppRuntimeMock.hydrateKodyRuntimeModules.mockImplementation(
		async ({ modules }) => ({
			modules,
			dynamicDependencyPackageIds: ['dynamic-dep-package'],
		}),
	)

	await buildPackageAppWorker(
		makeBuildInput(env, 'grants', { savedPackage: { id: 'root-package' } }),
	)

	expect(packageAppRuntimeMock.packageAppRuntimeBridge).toHaveBeenCalledWith({
		props: expect.objectContaining({
			packageId: 'root-package',
			packageStorageGrantIds: expect.arrayContaining([
				'root-package',
				'static-dep-package',
				'dynamic-dep-package',
			]),
		}),
	})
	const bridgeProps = packageAppRuntimeMock.packageAppRuntimeBridge.mock
		.calls[0]?.[0] as {
		props: { packageStorageGrantIds: Array<string> }
	}
	expect(bridgeProps.props.packageStorageGrantIds).toHaveLength(3)
})
