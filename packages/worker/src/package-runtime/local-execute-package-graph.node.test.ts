import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi, beforeEach } from 'vitest'
import type * as PublishedBundleArtifactsModule from './published-bundle-artifacts.ts'
import {
	moduleGraphMockModule as mockModule,
	createSavedPackageRecord,
} from '#worker/test-support/module-graph.ts'
import {
	buildLocalExecutePackageGraph,
	localExecuteHostRuntimeModuleName,
	type LocalExecutePackageGraphError,
} from './local-execute-package-graph.ts'
import {
	createLocalExecutePackageRuntimeModuleSource,
	createLocalExecuteRuntimeShimSource,
} from './local-execute-runtime-support.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import { verifyLocalExecutePackageBindingClaims } from './local-execute-package-binding.ts'
import {
	resolveRelativeModulePath,
	runtimeModulePath,
} from './module-graph-paths.ts'

vi.mock('#worker/package-registry/repo.ts', () => ({
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<typeof PublishedBundleArtifactsModule>(
		'./published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
	}
})

beforeEach(() => {
	vi.clearAllMocks()
})

const graphInput = {
	env: {
		APP_DB: {},
		REPO_SESSION: {},
		SECRET_STORE_KEY: 'test-secret-store-key',
	} as unknown as Env,
	baseUrl: 'https://heykody.dev',
	userId: ownerIdFromStored('user-1'),
	actorUserId: 'actor-1',
}

const examplePackage = {
	name: '@kentcdodds/example-package',
	kodyId: 'example-package',
}

function makeLoadedSource(input: {
	exports: Record<string, string>
	files: Record<string, string>
	publishedCommit?: string | null
	dependencies?: Record<string, string>
}) {
	const packageJson = JSON.stringify({
		name: examplePackage.name,
		exports: input.exports,
		...(input.dependencies ? { dependencies: input.dependencies } : {}),
		kody: { id: examplePackage.kodyId, description: 'Example package' },
	})
	return {
		source: {
			id: 'source-1',
			published_commit: input.publishedCommit ?? 'commit-1',
		},
		manifest: {
			name: examplePackage.name,
			exports: input.exports,
			kody: { id: examplePackage.kodyId, description: 'Example package' },
			...(input.dependencies ? { dependencies: input.dependencies } : {}),
		},
		files: {
			'package.json': packageJson,
			...input.files,
		},
	}
}

function makeArtifactHit(input: {
	artifactName: string
	entryPoint: string
	mainModule: string
	modules: Record<string, string>
}) {
	return {
		row: { id: `artifact-${input.artifactName}` },
		artifact: {
			version: 1,
			kind: 'importable-module' as const,
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: input.modules,
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: examplePackage.kodyId,
				sourceId: 'source-1',
			},
			createdAt: '2026-05-01T00:00:00.000Z',
		},
	}
}

test('buildLocalExecutePackageGraph returns embeddable kody:@ modules from published artifacts', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts':
					'export function greet(name) { return "hi " + name }\nexport default greet',
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './hello',
			entryPoint: 'src/hello.ts',
			mainModule: 'dist/hello.js',
			modules: {
				'dist/hello.js':
					'export function greet(name) { return "hi " + name }\nexport default greet',
			},
		}),
	)

	const code = `import { greet } from 'kody:@kentcdodds/example-package/hello'
export default async function main(params) { return greet(params.name) }`
	const graph = await buildLocalExecutePackageGraph({ ...graphInput, code })

	expect(graph.imports).toEqual(['kody:@kentcdodds/example-package/hello'])
	expect(graph.warnings).toEqual([])
	expect(graph.packageIdsByImport).toEqual({
		'kody:@kentcdodds/example-package/hello': 'pkg-1',
	})
	expect(Object.keys(graph.packageBindings)).toEqual(['pkg-1'])
	expect(graph.packageBindings['pkg-1']).toMatch(/^kpb1\./)
	// The entry code's direct imports are the run's entries, signed into
	// every binding so CapabilityProxy reads mappings from the entry.
	await expect(
		verifyLocalExecutePackageBindingClaims({
			env: graphInput.env,
			token: graph.packageBindings['pkg-1'],
			subject: { org: graphInput.userId, actor: graphInput.actorUserId },
		}),
	).resolves.toEqual({ packageId: 'pkg-1', entryPackageIds: ['pkg-1'] })
	const entry = graph.modules.find(
		(module) => module.name === 'kody:@kentcdodds/example-package/hello',
	)
	expect(entry).toBeDefined()
	expect(entry?.esModule).toMatch(/from ["']\.\.?\/.*\.__published_bundle__\//)
	expect(entry?.esModule).toContain('dist/hello.js')
	expect(entry?.esModule).not.toMatch(/from ["']\.__kody_packages__\//)
	expect(
		graph.modules.some(
			(module) =>
				module.name.includes('.__published_bundle__/') &&
				module.name.endsWith('/dist/hello.js'),
		),
	).toBe(true)
	expect(
		graph.modules.some(
			(module) => module.name === '.__kody_virtual__/runtime.js',
		),
	).toBe(true)
	const runtimeShim = graph.modules.find(
		(module) => module.name === '.__kody_virtual__/runtime.js',
	)?.esModule
	expect(runtimeShim).toContain(localExecuteHostRuntimeModuleName)
	// Bare "kody:runtime" path-joins under .__kody_virtual__/ in local workerd.
	expect(runtimeShim).toContain('"../kody:runtime"')
	expect(runtimeShim).not.toMatch(/from ["']kody:runtime["']/)
	// Shim owns secretHeaders / oauthClientCredentials — do not re-export the
	// CLI host's intentional `undefined` placeholders.
	expect(runtimeShim).not.toMatch(
		/import \{[\s\S]*secretHeaders[\s\S]*\} from ["']\.\.\/kody:runtime["']/,
	)
	const packageRuntimeModules = graph.modules.filter((module) =>
		module.name.includes('/.__kody_virtual__/package-runtime/'),
	)
	for (const module of packageRuntimeModules) {
		expect(module.esModule).toContain(
			'__kodyCreatePackageBoundAuthenticatedFetch',
		)
	}
	expect(
		graph.modules.some((module) => module.name.startsWith('.__kody_root__/')),
	).toBe(false)
})

test('buildLocalExecutePackageGraph rewrites inlined virtual runtime onto the CapabilityProxy shim', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './smoke-test': './src/smoke-test.ts' },
			files: {
				'src/smoke-test.ts': `import { createAuthenticatedFetch } from 'kody:runtime'
export default async function smokeTest() { return typeof createAuthenticatedFetch }`,
			},
		}),
	)
	const packageId = '2cc996d8-c0f5-4339-a6c1-9b6206123e96'
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './smoke-test',
			entryPoint: 'src/smoke-test.ts',
			mainModule: 'dist/smoke-test.js',
			modules: {
				'dist/smoke-test.js': `// virtual:.__kody_virtual__/runtime.js
import { AsyncLocalStorage } from "node:async_hooks";
var __kodyRuntimeStorage = new AsyncLocalStorage();
var __kodyInitialRuntime = __kodyRuntimeStorage.getStore();
function __kodyOptionalRuntimeFunctionExport(exportName) {
  if (__kodyInitialRuntime === void 0) return void 0;
  return () => {};
}
function __kodyCreatePackageBoundStorage(id) { return () => ({ id }); }
function __kodyCreatePackageBoundSecrets(id) { return { get: async () => "", has: async () => false }; }
var createAuthenticatedFetch = __kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch");
var runtime_default = { createAuthenticatedFetch };
// virtual:.__kody_virtual__/package-runtime/abc.js
var packageStorage2 = __kodyCreatePackageBoundStorage(${JSON.stringify(packageId)});
var packageSecrets2 = __kodyCreatePackageBoundSecrets(${JSON.stringify(packageId)});
// virtual:.__kody_root__/src/smoke-test.ts
export default async function smokeTest() {
  return typeof createAuthenticatedFetch;
}
`,
				'.__kody_virtual__/runtime.js':
					'export function createAuthenticatedFetch() { throw new Error("stale") }',
			},
		}),
	)

	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: `import smokeTest from 'kody:@kentcdodds/example-package/smoke-test'
export default async function main() { return await smokeTest() }`,
	})

	const bundle = graph.modules.find((module) =>
		module.name.endsWith('/dist/smoke-test.js'),
	)
	expect(bundle).toBeDefined()
	expect(bundle?.esModule).toContain(
		'__kodyCreatePackageBoundAuthenticatedFetch',
	)
	expect(bundle?.esModule).toContain(JSON.stringify(packageId))
	expect(bundle?.esModule).not.toContain(
		'__kodyOptionalRuntimeFunctionExport("createAuthenticatedFetch")',
	)
	expect(bundle?.esModule).toContain(
		'// virtual:.__kody_root__/src/smoke-test.ts',
	)
})

test('buildLocalExecutePackageGraph rewrites user-secret placeholders onto gateway fetch', async () => {
	const packageId = 'pkg-1'
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { '.': './src/index.ts' },
			files: {
				'src/index.ts': `const SECRET_API_TOKEN = '{{secret:demoAnalyticsToken|scope=user}}'
export async function listSites() {
  return fetch('https://api.usefathom.com/v1/sites', {
    headers: { authorization: 'Bearer ' + SECRET_API_TOKEN },
  })
}
export default listSites`,
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: '.',
			entryPoint: 'src/index.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js': `const SECRET_API_TOKEN = '{{secret:demoAnalyticsToken|scope=user}}';
export async function listSites() {
  return fetch("https://api.usefathom.com/v1/sites", {
    headers: { authorization: "Bearer " + SECRET_API_TOKEN }
  });
}
export default listSites;
`,
			},
		}),
	)

	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: `import { listSites } from 'kody:@kentcdodds/example-package'
export default async function main() { return await listSites() }`,
	})

	const bundle = graph.modules.find((module) =>
		module.name.endsWith('/dist/index.js'),
	)
	expect(bundle).toBeDefined()
	expect(bundle?.esModule).not.toContain(
		'{{secret:demoAnalyticsToken|scope=user}}',
	)
	expect(bundle?.esModule).toContain(
		'__kodySecretRef("demoAnalyticsToken", "user")',
	)
	expect(bundle?.esModule).toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(bundle?.esModule).toContain(JSON.stringify(packageId))
	const runtimeShim = graph.modules.find(
		(module) => module.name === '.__kody_virtual__/runtime.js',
	)?.esModule
	expect(runtimeShim).toContain('__kodyGatewayFetch')
	expect(runtimeShim).toContain('kody.gatewayFetch')
})

test('buildLocalExecutePackageGraph imports free nested meter helper for inlined callees', async () => {
	const nestedPackageId = '41095c29-4539-4f2f-a6fb-646348602c18'
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './advance': './src/advance.ts' },
			files: {
				'src/advance.ts': `export default async function advance() { return null }`,
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './advance',
			entryPoint: 'src/advance.ts',
			mainModule: 'dist/advance.js',
			modules: {
				'dist/advance.js': `var DISCORD_BOT_AUTHORIZATION = "Bot {{secret:discordBotTokenKentPersonalAutomation}}";
async function discordFetch(path, init) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", DISCORD_BOT_AUTHORIZATION);
  return fetch("https://discord.com/api/v10" + path, { ...init, headers });
}
var editMessage = __kodyMeterStaticPackageExport(${JSON.stringify(nestedPackageId)}, async function edit() {
  return discordFetch("/channels/1/messages/2", { method: "PATCH", body: "{}" });
});
export default async function advance() {
  return editMessage({ dryRun: true });
}
`,
			},
		}),
	)

	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: `import advance from 'kody:@kentcdodds/example-package/advance'
export default async function main() { return await advance() }`,
	})

	const bundle = graph.modules.find((module) =>
		module.name.endsWith('/dist/advance.js'),
	)
	expect(bundle).toBeDefined()
	expect(bundle?.esModule).toMatch(
		/import\s*\{[^}]*__kodyMeterStaticPackageExport[^}]*\}/,
	)
	expect(bundle?.esModule).toContain(
		`__kodyMeterStaticPackageExport(${JSON.stringify(nestedPackageId)}`,
	)
	expect(bundle?.esModule).toContain('__kodyCreatePackageBoundGatewayFetch')
	expect(bundle?.esModule).toMatch(
		/__kodyCreatePackageBoundGatewayFetch\("pkg-1"\)/,
	)
})

test('local secretHeaders.basic parses opaque {{secret:…}} refs like cloud', () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('const __kodyParseSecretNameOrPlaceholder')
	const end = shim.indexOf('// Client-credentials grants need host-side')
	expect(start).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(start)
	const helpersSource = shim
		.slice(start, end)
		.replace('export const secretHeaders', 'const secretHeaders')
	const secretHeaders = new Function(
		`${helpersSource}; return secretHeaders;`,
	)()
	expect(
		secretHeaders.basic({
			usernameSecret: '{{secret:paypalClientId|scope=user}}',
			passwordSecret: '{{secret:paypalClientSecret|scope=user}}',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
	expect(
		secretHeaders.basic({
			usernameSecret: 'paypalClientId',
			passwordSecret: 'paypalClientSecret',
			scope: 'user',
		}),
	).toBe(
		'{{secret-basic:username=paypalClientId,password=paypalClientSecret|scope=user}}',
	)
})

test('local gateway fetch always hops a credential client request, which carries only a handle', async () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('const __kodyNullBodyStatuses')
	const end = shim.indexOf('export function __kodyCreatePackageBoundStorage')
	const helpersSource = shim.slice(start, end).replaceAll(/^export /gm, '')
	const gatewayCalls: Array<unknown> = []
	const kody = {
		gatewayFetch: async (args: unknown) => {
			gatewayCalls.push(args)
			return { status: 200, statusText: 'OK', headers: {}, bodyBase64: '' }
		},
	}
	const originalFetch = globalThis.fetch
	const ambientCalls: Array<unknown> = []
	globalThis.fetch = (async (input: unknown) => {
		ambientCalls.push(input)
		return new Response('ambient')
	}) as typeof fetch
	try {
		const { __kodyGatewayFetch } = new Function(
			'kody',
			`${helpersSource}; return { __kodyGatewayFetch };`,
		)(kody) as {
			__kodyGatewayFetch: (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => Promise<Response>
		}
		await __kodyGatewayFetch(
			new Request('https://api.example.com/v1', {
				headers: { 'x-kody-credential-client': 'kch1.a.b' },
				redirect: 'manual',
			}),
		)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toMatchObject([
			{
				request: {
					url: 'https://api.example.com/v1',
					headers: { 'x-kody-credential-client': 'kch1.a.b' },
				},
			},
		])
	} finally {
		globalThis.fetch = originalFetch
	}
	expect(shim).toContain(
		'export const credential = __kodyCredentialRuntime.credential;',
	)
	expect(shim).toContain(
		'export const credentials = __kodyCredentialRuntime.credentials;',
	)
	// Ad hoc / unpublished local execute imports these from the CLI host
	// kody:runtime; the shim stays the single source of the client runtime for
	// published modules and the gateway-fetch hop. Neither surface may embed
	// secret plaintext helpers — only CapabilityProxy tool names + the opaque
	// handle header.
	expect(shim).toContain('credentialClientOpen')
	expect(shim).toContain('x-kody-credential-client')
	expect(shim).not.toMatch(/secretValue|plaintextSecret|apiKeyValue/)
	const packageRuntime = createLocalExecutePackageRuntimeModuleSource('pkg-1')
	expect(packageRuntime).toContain(
		'__kodyCreatePackageBoundCredentialRuntime("pkg-1")',
	)
	expect(packageRuntime).toContain(
		'export const credential = __kodyPackageCredentialRuntime.credential;',
	)
})

test('local gateway fetch hops scoped secrets and preserves ambient body metadata', async () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('const __kodyNullBodyStatuses')
	const end = shim.indexOf('export function __kodyCreatePackageBoundStorage')
	expect(start).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(start)
	const helpersSource = shim.slice(start, end).replaceAll(/^export /gm, '')
	const ambientCalls: Array<{ input: unknown; init: unknown }> = []
	const gatewayCalls: Array<unknown> = []
	const gatewayStreamCalls: Array<unknown> = []
	const kody = {
		gatewayFetch: async (args: unknown) => {
			gatewayCalls.push(args)
			return {
				status: 200,
				statusText: 'OK',
				headers: {},
				bodyBase64: btoa('gw'),
			}
		},
		gatewayFetchStream: async (args: unknown) => {
			gatewayStreamCalls.push(args)
			return new Response('stream-gw', { status: 200 })
		},
	}
	const originalFetch = globalThis.fetch
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		ambientCalls.push({ input, init })
		return new Response('ambient')
	}) as typeof fetch
	try {
		const { __kodyGatewayFetch } = new Function(
			'kody',
			`${helpersSource}; return { __kodyGatewayFetch };`,
		)(kody) as {
			__kodyGatewayFetch: (
				input: RequestInfo | URL,
				init?: RequestInit,
			) => Promise<Response>
		}

		await __kodyGatewayFetch('https://api.example.com/v1', {
			headers: {
				authorization: 'Bearer {{secret:demoToken|scope=user}}',
			},
		})
		expect(gatewayCalls).toHaveLength(1)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/v1',
				headers: {
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				},
			},
		})

		gatewayCalls.length = 0
		await __kodyGatewayFetch(
			new Request('https://api.example.com/bot{{secret:demoToken}}/me'),
		)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(1)
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/bot%7B%7Bsecret:demoToken%7D%7D/me',
			},
		})

		ambientCalls.length = 0
		gatewayCalls.length = 0
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: 'plain-text-body',
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		// Reuse original init so ambient fetch keeps implicit Content-Type.
		expect(ambientCalls[0]?.input).toBe('https://api.example.com/post')
		expect((ambientCalls[0]?.init as RequestInit).body).toBe('plain-text-body')

		// A large upload without placeholders is scanned in place and sent as
		// the caller's own body, not a buffered copy.
		ambientCalls.length = 0
		const largeUpload = new Blob(['x'.repeat(3 * 1024 * 1024)], {
			type: 'application/octet-stream',
		})
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'PUT',
			body: largeUpload,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect((ambientCalls[0]?.init as RequestInit).body).toBe(largeUpload)

		// A placeholder straddling a scan chunk boundary still hops.
		const straddling = new TextEncoder().encode(
			`${'x'.repeat(64 * 1024 - 5)}{{secret:demoToken}}`,
		)
		gatewayStreamCalls.length = 0
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'PUT',
			body: straddling,
		})
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'PUT',
			body: new Blob([straddling]),
		})
		// Bytes buffer into the JSON hop; Blobs stream via gatewayFetchStream.
		expect(gatewayCalls).toHaveLength(1)
		expect(gatewayStreamCalls).toHaveLength(1)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('hello'))
				controller.close()
			},
		})
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: stream,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(gatewayStreamCalls[0]).toMatchObject({
			request: { url: 'https://api.example.com/post', method: 'POST' },
		})
		expect(
			(gatewayStreamCalls[0] as { request: { body: ReadableStream } }).request
				.body,
		).toBeInstanceOf(ReadableStream)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const secretStream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('before-'))
				controller.enqueue(new TextEncoder().encode('{{secret:demoToken}}'))
				controller.enqueue(new TextEncoder().encode('-after'))
				controller.close()
			},
		})
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: secretStream,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(
			(gatewayStreamCalls[0] as { request: { body: ReadableStream } }).request
				.body,
		).toBe(secretStream)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const decodeBody = (call: unknown) =>
			atob((call as { request: { bodyBase64: string } }).request.bodyBase64)
		const bodySecretText = '{"note":"{{secret:demoToken|scope=user}}"}'
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: bodySecretText,
		})
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: new URLSearchParams({ token: '{{secret:demoToken}}' }),
		})
		await __kodyGatewayFetch(
			new Request('https://api.example.com/post', {
				method: 'POST',
				body: '{{integration-token:github}}',
			}),
		)
		const bigBlobBody = new Blob([
			'x'.repeat(2 * 1024 * 1024),
			'{{secret:demoToken}}',
		])
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'POST',
			body: bigBlobBody,
		})
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(3)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(decodeBody(gatewayCalls[0])).toBe(bodySecretText)
		expect(gatewayCalls[1]).toMatchObject({
			request: {
				headers: {
					'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
				},
			},
		})
		expect(decodeBody(gatewayCalls[1])).toBe(
			'token=%7B%7Bsecret%3AdemoToken%7D%7D',
		)
		expect(decodeBody(gatewayCalls[2])).toBe('{{integration-token:github}}')
		expect(
			(gatewayStreamCalls[0] as { request: { body: ReadableStream } }).request
				.body,
		).toBeInstanceOf(ReadableStream)

		gatewayCalls.length = 0
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			headers: { 'x-kody-secret-resolution': 'headers-only' },
			body: bodySecretText,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect((ambientCalls[0]?.init as RequestInit).body).toBe(bodySecretText)
		expect(
			new Headers((ambientCalls[0]?.init as RequestInit).headers).has(
				'x-kody-secret-resolution',
			),
		).toBe(false)

		ambientCalls.length = 0
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			headers: {
				authorization: 'Bearer {{secret:demoToken}}',
				'x-kody-secret-resolution': 'headers-only',
			},
			body: bodySecretText,
		})
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(1)
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				headers: {
					authorization: 'Bearer {{secret:demoToken}}',
					'x-kody-secret-resolution': 'headers-only',
				},
			},
		})

		// Multipart hops through the streaming gateway so part placeholders fill.
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		ambientCalls.length = 0
		const namedFileForm = new FormData()
		namedFileForm.set('upload', new Blob(['plain']), '{{secret:demoToken}}.txt')
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'POST',
			body: namedFileForm,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)

		gatewayStreamCalls.length = 0
		await __kodyGatewayFetch(
			'https://api.example.com/{{secret:demoToken}}/upload',
			{
				method: 'POST',
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('plain'))
						controller.close()
					},
				}),
			},
		)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)

		ambientCalls.length = 0
		gatewayStreamCalls.length = 0
		const braceStream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('keep {{not-a-secret}}'))
				controller.close()
			},
		})
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: braceStream,
		})
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)

		ambientCalls.length = 0
		const typedBlob = new Blob(['blob-body'], { type: 'application/json' })
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: typedBlob,
		})
		expect(ambientCalls).toHaveLength(1)
		expect((ambientCalls[0]?.init as RequestInit).body).toBe(typedBlob)
		expect(
			new Request(
				ambientCalls[0]?.input as string,
				ambientCalls[0]?.init as RequestInit,
			).headers.get('content-type'),
		).toBe('application/json')

		// Non-secret Blob wrapped in a Request reaches ambient fetch without a
		// clone().arrayBuffer() copy (kody#3152).
		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const wrappedBlob = new Blob(['wrapped-blob-body'], {
			type: 'application/octet-stream',
		})
		const blobRequest = new Request('https://api.example.com/upload', {
			method: 'POST',
			body: wrappedBlob,
		})
		await __kodyGatewayFetch(blobRequest)
		expect(gatewayCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBe(blobRequest)
		expect(await (ambientCalls[0]?.input as Request).text()).toBe(
			'wrapped-blob-body',
		)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const largeWrappedBlob = new Blob(['y'.repeat(3 * 1024 * 1024)], {
			type: 'application/octet-stream',
		})
		await __kodyGatewayFetch(
			new Request('https://api.example.com/upload', {
				method: 'PUT',
				body: largeWrappedBlob,
			}),
		)
		expect(gatewayCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBeInstanceOf(Request)

		ambientCalls.length = 0
		const request = new Request('https://api.example.com/post', {
			method: 'POST',
			body: 'payload',
			cache: 'no-store',
		})
		await __kodyGatewayFetch(request)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBeInstanceOf(Request)
		const forwarded = ambientCalls[0]?.input as Request
		expect(forwarded.url).toBe('https://api.example.com/post')
		expect(forwarded.method).toBe('POST')
		expect(forwarded.cache).toBe('no-store')
		expect(await forwarded.text()).toBe('payload')

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const wrappedStream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('wrapped-hello'))
				controller.close()
			},
		})
		const wrappedRequest = new Request('https://api.example.com/post', {
			method: 'POST',
			body: wrappedStream,
			duplex: 'half',
		} as RequestInit & { duplex: 'half' })
		await __kodyGatewayFetch(wrappedRequest)
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(
			(gatewayStreamCalls[0] as { request: { body: ReadableStream } }).request
				.body,
		).toBeInstanceOf(ReadableStream)

		ambientCalls.length = 0
		gatewayStreamCalls.length = 0
		const storedStream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('stored'))
				controller.close()
			},
		})
		const storedRequest = new Request('https://api.example.com/post', {
			method: 'POST',
			body: storedStream,
			cache: 'no-store',
			duplex: 'half',
		} as RequestInit & { duplex: 'half' })
		await __kodyGatewayFetch(storedRequest)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(ambientCalls).toHaveLength(0)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		const largePayload = `${'b'.repeat(5000)}tail`
		const largeRequest = new Request('https://api.example.com/post', {
			method: 'POST',
			body: largePayload,
			cache: 'no-store',
			headers: { authorization: 'Bearer {{secret:demoToken}}' },
		})
		await __kodyGatewayFetch(largeRequest)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(1)
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/post',
				headers: { authorization: 'Bearer {{secret:demoToken}}' },
			},
		})

		ambientCalls.length = 0
		gatewayCalls.length = 0
		const trailingBraces = new Blob(['report {{'])
		await __kodyGatewayFetch('https://api.example.com/post', {
			method: 'POST',
			body: trailingBraces,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect((ambientCalls[0]?.init as RequestInit).body).toBe(trailingBraces)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		const form = new FormData()
		form.set('note', 'hello')
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'POST',
			body: form,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)

		gatewayStreamCalls.length = 0
		await expect(
			__kodyGatewayFetch('https://api.example.com/upload', {
				method: 'POST',
				headers: {
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				},
				body: form,
			}),
		).resolves.toBeInstanceOf(Response)
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(gatewayStreamCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/upload',
				headers: {
					authorization: 'Bearer {{secret:demoToken|scope=user}}',
				},
			},
		})
		expect(
			(gatewayStreamCalls[0] as { request: { body?: unknown } }).request.body,
		).toBeDefined()

		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		ambientCalls.length = 0
		const pathSecretForm = new FormData()
		pathSecretForm.set('note', 'hello')
		await __kodyGatewayFetch(
			'https://api.example.com/bot{{secret:demoToken|scope=user}}/upload',
			{
				method: 'POST',
				body: pathSecretForm,
			},
		)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(gatewayStreamCalls[0]).toMatchObject({
			request: {
				url: 'https://api.example.com/bot{{secret:demoToken|scope=user}}/upload',
			},
		})

		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		ambientCalls.length = 0
		const placeholderForm = new FormData()
		placeholderForm.set('{{secret:demoToken|scope=user}}', 'field-value')
		await __kodyGatewayFetch('https://api.example.com/upload', {
			method: 'POST',
			body: placeholderForm,
		})
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)

		ambientCalls.length = 0
		gatewayStreamCalls.length = 0
		const requestForm = new FormData()
		requestForm.set('note', '{{secret:demoToken|scope=user}}')
		await __kodyGatewayFetch(
			new Request('https://api.example.com/upload', {
				method: 'POST',
				headers: { 'x-kody-secret-resolution': 'headers-only' },
				body: requestForm,
			}),
		)
		expect(gatewayCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(0)
		const forwardedForm = ambientCalls[0]?.input as Request
		expect(forwardedForm.headers.has('x-kody-secret-resolution')).toBe(false)

		ambientCalls.length = 0
		await __kodyGatewayFetch(
			new Request('https://api.example.com/get', {
				headers: { 'x-kody-secret-resolution': 'off' },
			}),
		)
		const forwardedGet = ambientCalls[0]?.input as Request
		expect(forwardedGet).toBeInstanceOf(Request)
		expect(forwardedGet.url).toBe('https://api.example.com/get')
		expect(forwardedGet.headers.has('x-kody-secret-resolution')).toBe(false)
		expect(await forwardedForm.text()).toContain(
			'{{secret:demoToken|scope=user}}',
		)

		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		await __kodyGatewayFetch(
			new Request('https://api.example.com/post', {
				method: 'POST',
				body: new Blob(['x'.repeat(2 * 1024 * 1024), '{{secret:demoToken}}']),
			}),
		)
		expect(ambientCalls).toHaveLength(0)
		// Secret Blob-in-Request streams via gatewayFetchStream (no arrayBuffer).
		expect(gatewayCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(1)
		expect(
			(gatewayStreamCalls[0] as { request: { body: ReadableStream } }).request
				.body,
		).toBeInstanceOf(ReadableStream)

		// String/bytes Requests still use the clone probe and hop when needed.
		ambientCalls.length = 0
		gatewayCalls.length = 0
		gatewayStreamCalls.length = 0
		await __kodyGatewayFetch(
			new Request('https://api.example.com/post', {
				method: 'POST',
				body: '{"note":"{{secret:demoToken}}"}',
			}),
		)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayStreamCalls).toHaveLength(0)
		expect(gatewayCalls).toHaveLength(1)
		expect(decodeBody(gatewayCalls[0])).toBe('{"note":"{{secret:demoToken}}"}')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('local isolate wraps globalThis.fetch so frozen copies still hop secrets', async () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath)
	const start = shim.indexOf('const __kodyNullBodyStatuses')
	const end = shim.indexOf('export function __kodyCreatePackageBoundSecrets')
	expect(start).toBeGreaterThan(-1)
	expect(end).toBeGreaterThan(start)
	const helpersSource = shim.slice(start, end).replaceAll(/^export /gm, '')
	const ambientCalls: Array<{ input: unknown; init: unknown }> = []
	const gatewayCalls: Array<unknown> = []
	const kody = {
		gatewayFetch: async (args: unknown) => {
			gatewayCalls.push(args)
			return {
				status: 200,
				statusText: 'OK',
				headers: {},
				bodyBase64: btoa('gw'),
			}
		},
	}
	const patchedSymbol = Symbol.for('kody.localExecuteFetchPatched')
	const originalFetch = globalThis.fetch
	const originalPatched = Reflect.get(globalThis, patchedSymbol)
	globalThis.fetch = (async (input: unknown, init?: unknown) => {
		ambientCalls.push({ input, init })
		return new Response('ambient')
	}) as typeof fetch
	Reflect.deleteProperty(globalThis, patchedSymbol)
	try {
		new Function('kody', `${helpersSource}; return null;`)(kody)
		expect(Reflect.get(globalThis, patchedSymbol)).toBe(true)

		const frozenAlias = globalThis.fetch
		await frozenAlias('https://discord.com/api/v10/channels/1/messages/2', {
			method: 'PATCH',
			headers: {
				authorization: 'Bot {{secret:discordBotTokenKentPersonalAutomation}}',
			},
		})
		expect(gatewayCalls).toHaveLength(1)
		expect(ambientCalls).toHaveLength(0)
		expect(gatewayCalls[0]).toMatchObject({
			request: {
				url: 'https://discord.com/api/v10/channels/1/messages/2',
				headers: {
					authorization: 'Bot {{secret:discordBotTokenKentPersonalAutomation}}',
				},
			},
		})

		gatewayCalls.length = 0
		await globalThis.fetch('https://api.example.com/health')
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBe('https://api.example.com/health')

		ambientCalls.length = 0
		await globalThis.fetch(
			new Request('https://api.example.com/post', {
				method: 'POST',
				body: 'payload',
				cache: 'no-store',
			}),
		)
		expect(gatewayCalls).toHaveLength(0)
		expect(ambientCalls).toHaveLength(1)
		expect(ambientCalls[0]?.input).toBeInstanceOf(Request)
		const forwarded = ambientCalls[0]?.input as Request
		expect(forwarded.cache).toBe('no-store')
		expect(forwarded.method).toBe('POST')
		expect(await forwarded.text()).toBe('payload')
	} finally {
		globalThis.fetch = originalFetch
		if (originalPatched === undefined) {
			Reflect.deleteProperty(globalThis, patchedSymbol)
		} else {
			Reflect.set(globalThis, patchedSymbol, originalPatched)
		}
	}
})

test('local bound createAuthenticatedFetch sends its own package binding', async () => {
	const outerBinding = 'kpb1.outer-binding.sig'
	const innerBinding = 'kpb1.inner-binding.sig'
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath, {
		packageBindings: { 'pkg-outer': outerBinding, 'pkg-inner': innerBinding },
	})

	const bindingsStart = shim.indexOf('const __kodyPackageBindings')
	const bindingsEnd = shim.indexOf('// Pure placeholder builders')
	expect(bindingsStart).toBeGreaterThan(-1)
	expect(bindingsEnd).toBeGreaterThan(bindingsStart)
	const bindingsSource = shim.slice(bindingsStart, bindingsEnd)

	// Helpers + CAF live between null-body statuses and bound gatewayFetch.
	const cafStart = shim.indexOf('const __kodyNullBodyStatuses')
	const cafEnd = shim.indexOf(
		'export function __kodyCreatePackageBoundGatewayFetch',
		cafStart,
	)
	expect(cafStart).toBeGreaterThan(-1)
	expect(cafEnd).toBeGreaterThan(cafStart)
	const cafSource = shim.slice(cafStart, cafEnd).replaceAll(/^export /gm, '')

	const authCalls: Array<unknown> = []
	const kody = {
		authenticatedFetch: async (args: unknown) => {
			authCalls.push(args)
			return {
				status: 200,
				statusText: 'OK',
				headers: {},
				bodyBase64: btoa('ok'),
			}
		},
	}
	const {
		__kodyCreatePackageBoundAuthenticatedFetch,
		createAuthenticatedFetch,
	} = new Function(
		'kody',
		`${bindingsSource}
${cafSource}
return {
	__kodyCreatePackageBoundAuthenticatedFetch,
	createAuthenticatedFetch,
};`,
	)(kody) as {
		__kodyCreatePackageBoundAuthenticatedFetch: (
			packageId: string,
		) => (
			providerName: string,
		) => Promise<
			(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
		>
		createAuthenticatedFetch: (
			providerName: string,
		) => Promise<
			(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
		>
	}

	const outerFetch =
		await __kodyCreatePackageBoundAuthenticatedFetch('pkg-outer')('demo')
	await outerFetch('https://api.example.com/outer')
	expect(authCalls).toEqual([
		expect.objectContaining({
			providerName: 'demo',
			packageId: outerBinding,
		}),
	])

	authCalls.length = 0
	const innerFetch =
		await __kodyCreatePackageBoundAuthenticatedFetch('pkg-inner')('demo')
	await innerFetch('https://api.example.com/inner')
	expect(authCalls).toEqual([
		expect.objectContaining({
			providerName: 'demo',
			packageId: innerBinding,
		}),
	])

	authCalls.length = 0
	const unboundFetch = await createAuthenticatedFetch('demo')
	await unboundFetch('https://api.example.com/adhoc')
	expect(authCalls).toHaveLength(1)
	expect((authCalls[0] as { packageId?: string }).packageId).toBeUndefined()
})

test('local bound gatewayFetch sends its own package binding; meter does not elevate (GHSA-5fv3-qv7j-rqf5)', async () => {
	const outerBinding = 'kpb1.outer-binding.sig'
	const innerBinding = 'kpb1.inner-binding.sig'
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath, {
		packageBindings: { 'pkg-outer': outerBinding, 'pkg-inner': innerBinding },
	})
	// No ambient authority channel is left in the local shim.
	expect(shim).not.toContain('kody.getSecretAuthority')
	expect(shim).not.toContain('__kodyGetSecretAuthority')
	expect(shim).not.toContain('__kodyRunWithSecretAuthority')
	expect(shim).not.toContain('__kodySecretAuthorityPackageId')
	expect(shim).not.toContain('kody.localExecuteRuntimeStorageView')

	const bindingsStart = shim.indexOf('const __kodyPackageBindings')
	const bindingsEnd = shim.indexOf('// Pure placeholder builders')
	expect(bindingsStart).toBeGreaterThan(-1)
	expect(bindingsEnd).toBeGreaterThan(bindingsStart)
	const bindingsSource = shim.slice(bindingsStart, bindingsEnd)

	const meterStart = shim.indexOf(
		'export function __kodyMeterStaticPackageExport',
	)
	const meterEnd = shim.indexOf('export function packageStorage()', meterStart)
	expect(meterStart).toBeGreaterThan(-1)
	expect(meterEnd).toBeGreaterThan(meterStart)
	const meterSource = shim
		.slice(meterStart, meterEnd)
		.replaceAll(/^export /gm, '')

	const gatewayStart = shim.indexOf('const __kodyNullBodyStatuses')
	const gatewayEnd = shim.indexOf(
		'export function __kodyCreatePackageBoundStorage',
	)
	expect(gatewayStart).toBeGreaterThan(-1)
	expect(gatewayEnd).toBeGreaterThan(gatewayStart)
	const gatewaySource = shim
		.slice(gatewayStart, gatewayEnd)
		.replaceAll(/^export /gm, '')

	const gatewayCalls: Array<unknown> = []
	const kody = {
		gatewayFetch: async (args: unknown) => {
			gatewayCalls.push(args)
			return {
				status: 200,
				statusText: 'OK',
				headers: {},
				bodyBase64: btoa('gw'),
			}
		},
	}
	const {
		__kodyCreatePackageBoundGatewayFetch,
		__kodyGatewayFetch,
		__kodyMeterStaticPackageExport,
	} = new Function(
		'kody',
		`${bindingsSource}
${gatewaySource}
${meterSource}
return {
	__kodyCreatePackageBoundGatewayFetch,
	__kodyGatewayFetch,
	__kodyMeterStaticPackageExport,
};`,
	)(kody) as {
		__kodyCreatePackageBoundGatewayFetch: (
			packageId: string,
		) => (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
		__kodyGatewayFetch: (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => Promise<Response>
		__kodyMeterStaticPackageExport: <T>(packageId: string, exportValue: T) => T
	}

	const outerBoundFetch = __kodyCreatePackageBoundGatewayFetch('pkg-outer')
	const innerBoundFetch = __kodyCreatePackageBoundGatewayFetch('pkg-inner')
	const unknownBoundFetch = __kodyCreatePackageBoundGatewayFetch('pkg-unknown')
	// Metering only: calling the inner export through the meter does not make
	// the outer closed-over fetch act as the inner package.
	const innerExport = __kodyMeterStaticPackageExport('pkg-inner', async () => {
		await Promise.resolve()
		await outerBoundFetch('https://api.example.com/hook/x', {
			method: 'POST',
			headers: {
				authorization: 'Bearer {{secret:innerWake|scope=package}}',
			},
		})
		return 'done'
	})

	await expect(innerExport()).resolves.toBe('done')
	expect(gatewayCalls).toHaveLength(1)
	expect(gatewayCalls[0]).toMatchObject({
		packageId: outerBinding,
		request: {
			url: 'https://api.example.com/hook/x',
			headers: {
				authorization: 'Bearer {{secret:innerWake|scope=package}}',
			},
		},
	})

	gatewayCalls.length = 0
	await innerBoundFetch('https://api.example.com/hook/y', {
		method: 'POST',
		headers: {
			authorization: 'Bearer {{secret:innerWake|scope=package}}',
		},
	})
	expect(gatewayCalls).toEqual([
		expect.objectContaining({ packageId: innerBinding }),
	])

	// A package the graph did not bind sends no identity at all, and no hop
	// ever carries a bare package id.
	gatewayCalls.length = 0
	await unknownBoundFetch('https://api.example.com/v1', {
		headers: { authorization: 'Bearer {{secret:demoToken|scope=user}}' },
	})
	await __kodyGatewayFetch('https://api.example.com/v1', {
		headers: { authorization: 'Bearer {{secret:demoToken|scope=user}}' },
	})
	expect(gatewayCalls).toHaveLength(2)
	for (const call of gatewayCalls) {
		expect((call as { packageId?: string }).packageId).toBeUndefined()
	}
})

test('local shim binding table ignores inherited and non-string keys', () => {
	const shim = createLocalExecuteRuntimeShimSource(runtimeModulePath, {
		packageBindings: { 'pkg-a': 'kpb1.a.sig', __proto__: 'kpb1.bad' } as Record<
			string,
			string
		>,
	})
	const start = shim.indexOf('const __kodyPackageBindings')
	const end = shim.indexOf('// Pure placeholder builders')
	const lookup = new Function(
		`${shim.slice(start, end)}
return __kodyPackageBinding;`,
	)() as (packageId: unknown) => string | null
	expect(lookup('pkg-a')).toBe('kpb1.a.sig')
	expect(lookup('toString')).toBeNull()
	expect(lookup('__proto__')).toBeNull()
	expect(lookup({ toString: () => 'pkg-a' })).toBeNull()
})

test('buildLocalExecutePackageGraph re-exports nested published-bundle runtime.js to the primary shim', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './gmail': './src/gmail.ts' },
			files: {
				'src/gmail.ts': `import { createAuthenticatedFetch } from 'kody:runtime'\nexport async function searchMessages() { return typeof createAuthenticatedFetch }`,
			},
		}),
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(
		makeArtifactHit({
			artifactName: './gmail',
			entryPoint: 'src/gmail.ts',
			mainModule: 'dist/gmail.js',
			modules: {
				'dist/gmail.js': `import { createAuthenticatedFetch } from './.__kody_virtual__/runtime.js'\nexport async function searchMessages() { return typeof createAuthenticatedFetch }`,
				'.__kody_virtual__/runtime.js':
					'export function createAuthenticatedFetch() { throw new Error("stale") }',
			},
		}),
	)

	const code = `import { searchMessages } from 'kody:@kentcdodds/example-package/gmail'
export default async function main() {
	return { ok: true, kind: typeof searchMessages }
}`
	const graph = await buildLocalExecutePackageGraph({ ...graphInput, code })

	const primary = graph.modules.find(
		(module) => module.name === runtimeModulePath,
	)
	expect(primary?.esModule).toContain('"../kody:runtime"')
	expect(primary?.esModule).not.toMatch(/from ["']kody:runtime["']/)

	const nested = graph.modules.find(
		(module) =>
			module.name.includes('/.__published_bundle__/') &&
			module.name.endsWith('/.__kody_virtual__/runtime.js'),
	)
	expect(nested).toBeDefined()
	expect(nested?.name).toContain('/2e2f676d61696c/')
	expect(nested?.esModule).toMatch(/export \* from ["']\.\.\/\.\.\//)
	expect(nested?.esModule).not.toMatch(/from ["']kody:runtime["']/)
	expect(nested?.esModule).not.toContain('__kodyCreateAuthenticatedFetch')
	const reexportMatch =
		/export \* from ("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(
			nested?.esModule ?? '',
		)
	expect(reexportMatch?.[1]).toBeDefined()
	const reexportSpecifier = JSON.parse(
		reexportMatch![1]!.startsWith("'")
			? `"${reexportMatch![1]!.slice(1, -1).replaceAll('"', '\\"')}"`
			: reexportMatch![1]!,
	) as string
	expect(resolveRelativeModulePath(nested!.name, reexportSpecifier)).toBe(
		runtimeModulePath,
	)
})

test('buildLocalExecutePackageGraph rejects literal dynamic kody:@ imports', async () => {
	const code = `const m = await import('kody:@kentcdodds/example-package/hello')
export default async () => m`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'unsupported_dynamic_package_import',
	} satisfies Partial<LocalExecutePackageGraphError>)
	expect(mockModule.getSavedPackageByName).not.toHaveBeenCalled()
})

test('buildLocalExecutePackageGraph rejects unresolved packages', async () => {
	mockModule.getSavedPackageByName.mockResolvedValue(null)
	const code = `import x from 'kody:@missing/pkg/export'
export default async () => x`
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unresolved',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph rejects unpublished packages and missing artifacts', async () => {
	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)

	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
			publishedCommit: null,
		}),
	)
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)

	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			files: {
				'src/hello.ts': 'export default function hello() { return "hi" }',
			},
		}),
	)
	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph surfaces transient D1 unavailability instead of blaming the imports', async () => {
	const exportInProgress = new Error(
		'D1_ERROR: Currently processing a long-running export',
	)
	mockModule.getSavedPackageByName.mockRejectedValue(exportInProgress)
	const code = `import x from 'kody:@kentcdodds/example-package/hello'
export default async () => x`
	const rejection = await buildLocalExecutePackageGraph({
		...graphInput,
		code,
	}).then(
		() => {
			throw new Error('expected package graph to reject')
		},
		(error: unknown) => error,
	)
	expect(rejection).toBe(exportInProgress)
	expect(toApiError(rejection)).toMatchObject({
		status: 503,
		code: 'internal_error',
	})
})

test('buildLocalExecutePackageGraph maps missing runtime bundles to retry-or-report', async () => {
	const code = `import hello from 'kody:@kentcdodds/example-package/hello'
export default async () => hello()`
	mockModule.getSavedPackageByName.mockResolvedValue(createSavedPackageRecord())
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue(
		makeLoadedSource({
			exports: { './hello': './src/hello.ts' },
			dependencies: { marked: '18.0.2' },
			files: {
				'src/hello.ts':
					'import { marked } from "marked"\nexport default async function hello() { return marked.parse("**ok**") }',
			},
		}),
	)

	await expect(
		buildLocalExecutePackageGraph({ ...graphInput, code }),
	).rejects.toMatchObject({
		code: 'package_import_unpublished',
		message: expect.stringMatching(
			/missing a published runtime bundle.*Retry later or report it if it persists\./,
		),
	} satisfies Partial<LocalExecutePackageGraphError>)
})

test('buildLocalExecutePackageGraph always embeds the gateway-fetch shim without kody:@ imports', async () => {
	const graph = await buildLocalExecutePackageGraph({
		...graphInput,
		code: `export default async function main() {
  return fetch('https://api.example.com/v1', {
    headers: { authorization: 'Bearer {{secret:cloudflarePagesApiToken}}' },
  })
}`,
	})
	expect(graph.imports).toEqual([])
	expect(graph.warnings).toEqual([])
	expect(mockModule.getSavedPackageByName).not.toHaveBeenCalled()
	expect(graph.modules).toHaveLength(1)
	const runtimeShim = graph.modules[0]
	expect(runtimeShim?.name).toBe(runtimeModulePath)
	expect(runtimeShim?.esModule).toContain('__kodyGatewayFetch')
	expect(runtimeShim?.esModule).toContain('kody.gatewayFetch')
	expect(runtimeShim?.esModule).toContain('kody.localExecuteFetchPatched')
	expect(runtimeShim?.esModule).toMatch(/globalThis\.fetch\s*=/)
})
