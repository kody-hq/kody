import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { readFile } from 'node:fs/promises'
import { expect, test, vi } from 'vitest'
import { buildSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import { secretAuthorityArgName } from '#mcp/secrets/secret-authority.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import {
	createPackageStorageAccessDeniedMessage,
	createPackageStorageOwnerOnlyMessage,
} from '#worker/storage-runner.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import type * as ModuleGraph from './module-graph.ts'
import type * as PackageAppAuthority from './package-app-authority.ts'
import type * as PublishedBundleArtifacts from './published-bundle-artifacts.ts'
import type * as McpAuthUserContext from '#worker/mcp-auth-user-context.ts'
import type * as RunRecordsServiceModule from '#worker/run-records/service.ts'
import type * as Registry from '#mcp/capabilities/registry.ts'
import type * as PackageInvocationsService from '#worker/package-invocations/service.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

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
	'function createKodyProxy(runtimeBridge, mcpServerNamesOrLoader, identity = null) {',
	'\nfunction createRealtimeProxy',
)
const identityOnlyAnswerSource = extractGeneratedSource(
	'function __kodyIdentityOnlyAnswer(identity, name) {',
	'\nlet __kodyCapturedRuntimeBridge',
)

function createKodyProxyForTest(
	runtimeBridge: unknown,
	mcpServerNames: Array<string> | (() => Promise<Array<string>>) = [],
	identity: unknown = null,
) {
	return new Function(
		'runtimeBridge',
		'mcpServerNamesOrLoader',
		'identity',
		`function __kodyCurrentVisitTicket() { return null; }\nfunction __kodyTicketNamesVisitor() { return false; }\n${identityOnlyAnswerSource}\n${kodyProxySource}; return createKodyProxy(runtimeBridge, mcpServerNamesOrLoader, identity);`,
	)(runtimeBridge, mcpServerNames, identity) as Record<string, unknown>
}

/** Workerd-style: [[OwnPropertyKeys]] then GOPD.value (not plain Get). */
function getViaOwnKeysThenGopd(target: object, name: string): unknown {
	if (!Reflect.ownKeys(target).includes(name)) return undefined
	return Reflect.getOwnPropertyDescriptor(target, name)?.value
}

function createWorkflowsProxyForTest(runtimeBridge: unknown) {
	return new Function(
		'runtimeBridge',
		`function __kodyCurrentVisitTicket() { return null; }\n${extractGeneratedSource(
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

	// GHSA-5fv3: the run proxy never stamps package authority into args.
	expect(kodyProxySource).not.toContain(secretAuthorityArgName)

	const withoutNames = createKodyProxyForTest(runtimeBridge)
	await expect(
		(withoutNames.mcp as McpNamespace)['home']?.set_pin({ pin: '1234' }),
	).resolves.toEqual({ ok: true })
	expect(calls).toEqual([
		{
			name: 'mcp:home:set_pin',
			args: { pin: '1234' },
			visitTicket: null,
		},
	])
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
			visitTicket: null,
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
		// A planted getter is ignored; a forged field is passed through to
		// the bridge, which discards it (see the bridge secret-mount test).
		expect(calls.at(-1)).toEqual({
			name: 'mcp:home:set_pin',
			args: { pin: '4', [secretAuthorityArgName]: 'pkg-forged' },
			visitTicket: null,
		})
	} finally {
		delete (globalThis as unknown as Record<symbol, unknown>)[authoritySymbol]
	}
})

test('package app kody proxy answers only metaGetCurrentUser for an identity-only visitor', async () => {
	const calls: Array<string> = []
	const runtimeBridge = {
		callCapability: async ({ name }: { name: string }) => {
			calls.push(name)
			throw new Error('Authenticated MCP user is required for this capability')
		},
	}
	const identity = Object.freeze({
		user_id: 'person-outsider',
		username: 'outsider',
		email: '',
		display_name: 'outsider',
		org: Object.freeze({ slug: 'owner' }),
	})
	const proxy = createKodyProxyForTest(runtimeBridge, [], identity) as Record<
		string,
		(args?: unknown) => Promise<unknown>
	>
	await expect(proxy['metaGetCurrentUser']!({})).resolves.toEqual({
		user_id: 'person-outsider',
		username: 'outsider',
		email: '',
		display_name: 'outsider',
		org: { slug: 'owner' },
	})
	expect(calls).toEqual([])
	// Every other capability still goes to the anonymous bridge and fails closed.
	await expect(proxy['secretList']!({})).rejects.toThrow(
		'Authenticated MCP user is required',
	)
	expect(calls).toEqual(['secretList'])

	// Without an identity, metaGetCurrentUser goes to the bridge too.
	const anonymous = createKodyProxyForTest(runtimeBridge) as typeof proxy
	await expect(anonymous['metaGetCurrentUser']!({})).rejects.toThrow(
		'Authenticated MCP user is required',
	)
	expect(calls).toEqual(['secretList', 'metaGetCurrentUser'])
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

test('package app owned limit and spend helpers use the runtime bridge', async () => {
	const runtimeBridge = {
		appRateLimit: vi.fn(async () => ({
			allowed: false,
			retryAfterSeconds: 12,
		})),
		appSpendGet: vi.fn(async () => ({
			month: '2026-05',
			creditsMicroUsd: 2000,
			days: [],
		})),
		callCapability: vi.fn(async () => ({ unexpected: true })),
	}
	const proxy = createKodyProxyForTest(runtimeBridge) as Record<
		string,
		(args?: unknown) => Promise<unknown>
	>

	await expect(
		proxy.appRateLimit!({
			key: 'task',
			limit: 1,
			windowSeconds: 60,
		}),
	).resolves.toEqual({ allowed: false, retryAfterSeconds: 12 })
	await expect(proxy.appSpendGet!({})).resolves.toEqual({
		month: '2026-05',
		creditsMicroUsd: 2000,
		days: [],
	})
	expect(runtimeBridge.appRateLimit).toHaveBeenCalledWith({
		key: 'task',
		limit: 1,
		windowSeconds: 60,
	})
	expect(runtimeBridge.appSpendGet).toHaveBeenCalledWith()
	expect(runtimeBridge.callCapability).not.toHaveBeenCalled()
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

vi.mock('./package-app-authority.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof PackageAppAuthority>()
	return {
		...actual,
		loadPackageAppRunsAs: async () => ({
			status: 'ready',
			personId: personIdFromStored('user-1'),
			source: 'publisher',
			role: 'owner',
			email: 'user@example.com',
			username: 'user',
			displayName: 'User',
			request: {
				org: { id: ownerIdFromStored('user-1'), slug: 'user' },
				actor: { userId: personIdFromStored('user-1'), username: 'user' },
				membership: { role: 'owner' },
			},
		}),
	}
})

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
	const all = async () => ({ results: [] })
	const appDb = {
		prepare: () => ({ bind: () => ({ first: async () => null, all }) }),
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
				packageSecretRefKey: '',
				packageBindingToken: 'binding-token-for-test',
				gatewayProps: null,
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
	// No static runtime.js import at entry load (exports freeze from empty ALS).
	// Preload inside ALS.run via __kodyEnsureRuntimeLoaded, then enter the
	// private package-binding scope (GHSA-5fv3). No ambient getter or header.
	expect(packageAppHostSource).not.toMatch(
		/^import .+ from '\.\/\.__kody_virtual__\/runtime\.js'/m,
	)
	expect(packageAppHostSource).toContain('__kodyEnsureRuntimeLoaded')
	expect(packageAppHostSource).toContain(
		'__kodyRunWithPackageBindingsFn = runtimeModule.__kodyRunWithPackageBindings',
	)
	expect(packageAppHostSource).toContain(
		'__kodyScrubPackageAppSetCookieDomains',
	)
	expect(packageAppHostSource).toContain(
		'package-app-set-cookie-domain-stripped',
	)
	expect(packageAppHostSource).toContain('package-app-set-cookie-name-dropped')
	expect(packageAppHostSource).not.toContain('getSecretAuthority')
	expect(packageAppHostSource).not.toMatch(
		/headers\.set\([^)]*x-kody-secret-authority/,
	)
	const bridgeProps = packageAppRuntimeMock.packageAppRuntimeBridge.mock
		.calls[0]?.[0] as {
		props?: {
			credentialClientBinding?: string
			packageBindingToken?: string
			packageStorageGrantIds?: Array<string>
		}
	}
	expect(bridgeProps?.props?.credentialClientBinding).toMatch(/^run:/)
	// Per-build capability: in the bridge props and the wrapper module only.
	const token = bridgeProps?.props?.packageBindingToken ?? ''
	expect(token).toMatch(/^[0-9a-f]{64}$/)
	expect(packageAppHostSource).toContain(JSON.stringify(token))
	expect(packageAppHostSource).toContain(
		`const __kodyPackageBindingIds = __kodyObjectFreezeCaptured(${JSON.stringify(bridgeProps?.props?.packageStorageGrantIds ?? [])});`,
	)
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
		'call',
		`function __kodyCurrentVisitTicket() { return null; }
		${createCredentialClientRuntimeSource()}
		${extractGeneratedSource(
			'function createCredentialRuntime(runtimeBridge, call) {',
			'\nfunction createRuntime(runtimeBridge, packageContext, mcpServerNamesOrLoader, identity = null) {',
		)}
		return createCredentialRuntime(runtimeBridge, call);`,
	) as (
		bridge: CredentialRuntimeBridge,
		call?: (name: string, args: unknown) => Promise<unknown>,
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
			visitTicket: null,
		},
		{
			name: credentialClientToolNames.sign,
			args: {
				handle: 'h1',
				host: 'powersync.example',
				operation: { payload: { sub: 'user-1' } },
			},
			visitTicket: null,
		},
	])

	// A dependency's credential() goes through its trusted binding call
	// (GHSA-5fv3); the public bridge never sees a package id.
	calls.length = 0
	const boundCalls: Array<CredentialClientCallInput> = []
	const bound = createCredentialRuntime(runtimeBridge, async (name, args) => {
		boundCalls.push({ name, args })
		return await runtimeBridge.credentialClientCall({ name, args })
	})
	await bound.credential('resend')
	expect(boundCalls[0]).toEqual({
		name: credentialClientToolNames.open,
		args: { key: 'resend' },
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
		cookiePrefix: '__kapp_1358a8c63e1c_',
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
		appBasePath: '/client-app',
		hostedUrl: 'https://serving-owner.kody.run/client-app',
		assetBasePath: '/client-app/_assets',
		clientModuleUrl:
			'https://serving-owner.kody.run/client-app/_assets/client.abcdefgh12345678.js',
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
	const opaqueRef = buildSecretPlaceholder({ name: 'apiToken', scope: 'user' })
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

test('package app secret mounts ignore author-selected packageId and forged authority fields', async () => {
	const ref = buildSecretPlaceholder({ name: 'apiToken', scope: 'user' })
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
	// GHSA-5fv3: only the trusted per-package binding (packageBoundCall
	// with the wrapper capability) selects a package; caller fields never do.
	const forged = (input: Record<string, string>) =>
		bridge.packageSecretGet(input as { alias: string })
	const cases: Array<[() => Promise<unknown>, string]> = [
		[() => forged({ alias: 'api-token', packageId: 'pkg-a' }), 'package-1'],
		[
			() =>
				forged({
					alias: 'api-token',
					packageId: 'package-1',
					[secretAuthorityArgName]: 'pkg-a',
				}),
			'package-1',
		],
		[
			() =>
				bridge.packageBoundCall({
					token: 'binding-token-for-test',
					packageId: 'pkg-a',
					op: 'packageSecretGet',
					alias: 'api-token',
				}),
			'pkg-a',
		],
	]
	for (const [call, resolvedPackageId] of cases) {
		packageAppRuntimeMock.resolveCredential.mockClear()
		await expect(call()).resolves.toEqual({
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

	// Without the capability, or for a package outside the grant set, the
	// bound entry points refuse before resolving anything.
	packageAppRuntimeMock.resolveCredential.mockClear()
	for (const [token, packageId] of [
		['wrong-token', 'pkg-a'],
		['', 'pkg-a'],
		['binding-token-for-test', 'pkg-not-granted'],
	] as const) {
		await expect(
			bridge.packageBoundCall({
				token,
				packageId,
				op: 'packageSecretGet',
				alias: 'api-token',
			}),
		).rejects.toThrow()
		await expect(
			bridge.packageBoundFetch(
				token,
				packageId,
				new Request('https://example.com/api'),
			),
		).rejects.toThrow()
	}
	expect(packageAppRuntimeMock.resolveCredential).not.toHaveBeenCalled()
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
	const rc = (id: string, visitor?: string) => [id, visitor, undefined]
	expect(getStorageRunner).toHaveBeenCalledWith(
		...rc(buildPackageStorageId('package-1')),
	)
	expect(getValue).toHaveBeenCalledWith({ key: 'count' })

	// A granted dependency bucket is not reachable by naming its id from
	// the public bridge (that is the app's own code): only the dependency's
	// trusted binding reaches it (GHSA-5fv3).
	await expect(
		bridge.packageStorageSet({
			packageId: 'dep-package',
			key: 'flag',
			value: true,
		}),
	).rejects.toThrow(createPackageStorageOwnerOnlyMessage('dep-package'))
	expect(setValue).not.toHaveBeenCalled()
	await expect(
		bridge.packageBoundCall({
			token: 'binding-token-for-test',
			packageId: 'dep-package',
			op: 'packageStorage',
			name: 'packageStorageSet',
			args: { packageId: 'dep-package', key: 'flag', value: true },
		}),
	).resolves.toEqual({ ok: true })
	expect(getStorageRunner).toHaveBeenCalledWith(
		...rc(buildPackageStorageId('dep-package'), ''),
	)
	expect(setValue).toHaveBeenCalledWith({ key: 'flag', value: true })
	// The bound binding cannot be pointed at another granted bucket either.
	await expect(
		bridge.packageBoundCall({
			token: 'binding-token-for-test',
			packageId: 'dep-package',
			op: 'packageStorage',
			name: 'packageStorageGet',
			args: { packageId: 'package-1', key: 'count' },
		}),
	).rejects.toThrow(createPackageStorageOwnerOnlyMessage('package-1'))
	await expect(
		bridge.packageBoundCall({
			token: 'wrong-token',
			packageId: 'dep-package',
			op: 'packageStorage',
			name: 'packageStorageGet',
			args: { key: 'flag' },
		}),
	).rejects.toThrow('Package binding capability is invalid.')

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
	expect(getStorageRunner).toHaveBeenCalledWith(...rc('package-1:facet:main'))
	expect(getStorageRunner).toHaveBeenCalledWith(
		...rc('package-1:Counter:instance-a'),
	)

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

test('buildPackageAppWorker mints request-bound loopback bindings on every loader callback, never from the cached build', async () => {
	// Loopback fetchers are bound to the request that creates them; a cached
	// build's fetcher fails "Cannot perform I/O on behalf of a different request".
	const { env, loader } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(),
	)
	packageAppRuntimeMock.packageAppRuntimeBridge.mockClear()
	const buildInput = makeBuildInput(env, 'per-request-bindings')

	await buildPackageAppWorker(buildInput)
	await buildPackageAppWorker(buildInput)

	// Building (and reusing) the cached options mints nothing by itself.
	expect(packageAppRuntimeMock.packageAppRuntimeBridge).not.toHaveBeenCalled()
	expect(loader.get).toHaveBeenCalledTimes(2)
	type MaterializedRuntime = {
		props: {
			credentialClientBinding: string
			packageBindingToken: string
		}
	}
	type MaterializedWorker = {
		env: {
			KODY_RUNTIME: MaterializedRuntime
			__kodyPackageContext: unknown
		}
		modules: Record<string, string>
	}
	const [firstId, firstFactory] = loader.get.mock.calls[0] as unknown as [
		string,
		() => MaterializedWorker,
	]
	const [secondId, secondFactory] = loader.get.mock.calls[1] as unknown as [
		string,
		() => MaterializedWorker,
	]
	expect(secondId).toBe(firstId)
	const first = firstFactory()
	const second = secondFactory()
	expect(packageAppRuntimeMock.packageAppRuntimeBridge).toHaveBeenCalledTimes(2)
	// A fresh binding object per load. Credential binding is per request so
	// the cached template cannot reuse the first request's run binding.
	expect(second.env.KODY_RUNTIME).not.toBe(first.env.KODY_RUNTIME)
	expect(second.env.KODY_RUNTIME.props.credentialClientBinding).not.toBe(
		first.env.KODY_RUNTIME.props.credentialClientBinding,
	)
	expect(second.env.KODY_RUNTIME.props.packageBindingToken).toBe(
		first.env.KODY_RUNTIME.props.packageBindingToken,
	)
	expect(second.modules).toBe(first.modules)
	expect(second.env.__kodyPackageContext).toEqual(
		first.env.__kodyPackageContext,
	)
})

test("buildPackageAppWorker never reuses one visitor's request context or credential binding for another", async () => {
	// Visitors share one worker per app commit per mount; identity and binding
	// come per request from the visit ticket, never another visitor's.
	const { env, loader } = createPackageAppTestEnv()
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(),
	)
	packageAppRuntimeMock.packageAppRuntimeBridge.mockClear()
	const key = 'visitor-isolation'
	const orgId = `user-${key}`
	const visit = (
		actorId: string,
		role: 'owner' | 'member',
		orgSlug: string = key,
		billedOrgId?: string,
	) =>
		makeBuildInput(env, key, {
			runtime: {
				callerContext: {
					user: {
						userId: actorId,
						email: `${key}@example.com`,
						displayName: `${key} User`,
					},
					request: {
						org: { id: orgId, slug: orgSlug },
						actor: { userId: actorId, username: actorId },
						attribution: { kind: 'user', userId: actorId },
						credential: {
							kind: 'package-app',
							id: null,
							orgId,
							scopes: null,
						},
						membership: billedOrgId ? null : { role },
						...(billedOrgId ? { billing: { orgId: billedOrgId } } : {}),
					},
				},
			} as never,
		})
	type MaterializedBridge = {
		props: {
			visitor: { userId: string; role: string | null } | null
			orgSlug: string | null
			credentialClientBinding: string
			visitTicket: string | null
			gatewayProps: {
				credentialClientBinding?: string | null
				request: { actor: { userId: string } | null } | null
			}
		}
	}
	const loads: Array<{ id: string; bridge: MaterializedBridge }> = []
	const serve = async (input: BuildInput) => {
		await buildPackageAppWorker(input)
		const [id, factory] = loader.get.mock.calls.at(-1) as unknown as [
			string,
			() => { env: { KODY_RUNTIME: MaterializedBridge } },
		]
		loads.push({ id, bridge: factory().env.KODY_RUNTIME })
	}

	await serve(visit('person-a', 'owner'))
	await serve(visit('person-b', 'member'))
	await serve(visit('person-a', 'member'))
	await serve(visit('person-a', 'owner', 'renamed-org'))
	await serve(visit('person-a', 'owner'))
	await serve(visit('person-c', 'member', key, 'org-visitor-c'))
	const [first, other, demoted, renamed, again, crossOrg] = loads
	expect(crossOrg!.bridge.props.gatewayProps).toMatchObject({
		request: { billing: { orgId: 'org-visitor-c' } },
	})
	// Every visitor of this app and mount shares the isolate.
	expect(new Set(loads.map((load) => load.id)).size).toBe(1)
	// Per-request authority never copies another visitor's identity or binding.
	for (const load of [other!, demoted!, renamed!, again!]) {
		expect(load.bridge.props.credentialClientBinding).not.toBe(
			first!.bridge.props.credentialClientBinding,
		)
		expect(load.bridge.props.visitTicket).not.toBe(
			first!.bridge.props.visitTicket,
		)
	}
	expect(other!.bridge.props.visitor).toMatchObject({
		userId: 'person-b',
		role: 'member',
	})
	expect(other!.bridge.props.gatewayProps.request?.actor?.userId).toBe(
		'person-b',
	)
	expect(other!.bridge.props.gatewayProps.credentialClientBinding).toBe(
		other!.bridge.props.credentialClientBinding,
	)
	expect(demoted!.bridge.props.visitor?.role).toBe('member')
	expect(renamed!.bridge.props.visitor?.userId).toBe('person-a')
	expect(first!.bridge.props.visitor).toMatchObject({
		userId: 'person-a',
		role: 'owner',
	})
})

test('buildPackageAppWorker keeps one worker id per app commit per mount across build cache expiry', async () => {
	// A rebuild after cache expiry must land on the same worker id, or every
	// expiry mints another unique Dynamic Worker day and a cold isolate.
	const { env, loader } = createPackageAppTestEnv()
	const secretEnv = {
		...env,
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
	} as unknown as Env
	packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifact(),
	)
	packageAppRuntimeMock.packageAppRuntimeBridge.mockClear()
	const key = 'stable-across-expiry'
	type LoadedWorker = {
		env: { KODY_RUNTIME: { props: { packageBindingToken: string } } }
		modules: Record<string, string>
	}
	const loadOnce = async (input: BuildInput) => {
		await buildPackageAppWorker(input)
		const [id, factory] = loader.get.mock.calls.at(-1) as unknown as [
			string,
			() => LoadedWorker,
		]
		const worker = factory()
		return {
			id,
			token: worker.env.KODY_RUNTIME.props.packageBindingToken,
			source: Object.values(worker.modules).join('\n'),
		}
	}
	const start = Date.parse('2026-10-23T12:00:00.000Z')
	const now = vi.spyOn(Date, 'now').mockReturnValue(start)
	try {
		const first = await loadOnce(makeBuildInput(secretEnv, key))
		// Past the build cache TTL, still the same UTC day: this is a rebuild,
		// not a cache hit.
		const buildsBefore =
			packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mock.calls
				.length
		now.mockReturnValue(start + 6 * 60 * 1000)
		const rebuilt = await loadOnce(makeBuildInput(secretEnv, key))
		expect(
			packageAppRuntimeMock.loadPublishedBundleArtifactByIdentity.mock.calls
				.length,
		).toBeGreaterThan(buildsBefore)
		expect(rebuilt.id).toBe(first.id)
		// The binding capability stays sealed: 64 hex chars, carried only by the
		// bridge props and the wrapper module, and matching across the rebuild
		// so a warm isolate and its bridge always agree.
		expect(rebuilt.token).toMatch(/^[0-9a-f]{64}$/)
		expect(rebuilt.token).toBe(first.token)
		expect(rebuilt.source).toContain(JSON.stringify(rebuilt.token))

		// Another visitor of the same app and commit shares the worker id and
		// the per-build binding capability. Authority rides the visit ticket.
		const other = await loadOnce(
			makeBuildInput(secretEnv, key, {
				runtime: {
					callerContext: {
						user: {
							userId: 'person-other',
							email: `${key}@example.com`,
							displayName: `${key} User`,
						},
						request: {
							...appVisitorRequest(key),
							actor: { userId: 'person-other', username: 'person-other' },
							attribution: { kind: 'user', userId: 'person-other' },
						},
					},
				} as never,
			}),
		)
		expect(other.id).toBe(first.id)
		expect(other.token).toBe(first.token)
		expect(other.source).toContain(JSON.stringify(first.token))

		// A new UTC day rotates the capability (and so the worker id), which
		// matches the daily unit Cloudflare bills anyway.
		now.mockReturnValue(start + 24 * 60 * 60 * 1000)
		const nextDay = await loadOnce(makeBuildInput(secretEnv, key))
		expect(nextDay.token).not.toBe(first.token)
		expect(nextDay.id).not.toBe(first.id)
	} finally {
		now.mockRestore()
	}
})

test('buildPackageAppWorker passes packageStorage grant ids from root, static, and dynamic deps', async () => {
	// The fixture bundle is pre-fix shaped and the build passes no source, so
	// serving it is logged.
	silenceExpectedConsoleWarns([/pre_binding_bundle_served_without_source/])
	const { env, loader } = createPackageAppTestEnv()
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
	// The bridge is minted when the loader asks for the worker options.
	loaderWorkerOptions(loader)

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
