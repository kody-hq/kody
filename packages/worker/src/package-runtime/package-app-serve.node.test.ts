import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as PackageSourceModule from '#worker/package-registry/source.ts'
import type * as CredentialSuppliersFlag from '#worker/credentials/credential-suppliers-flag.ts'
import {
	consoleError,
	consoleWarn,
} from '#worker/test-support/console-spies.ts'
import { ComputeOverageLimitError } from '#worker/entitlements/errors.ts'
import { CredentialClientError } from '#worker/credentials/credential-client.ts'
import {
	packageAppRuntimeErrorHeader,
	packageAppRuntimeRunIdHeader,
} from './package-app-diagnostics.ts'
import {
	parsePackageAppCustomHostnamePath,
	parsePackageAppSubdomainPath,
	servePackageAppRequest,
	createPackageCodeRequest,
} from './package-app-serve.ts'
import {
	filterPackageAppRequestCookies,
	packageAppCookiePrefix,
} from './package-app-cookie-prefix.ts'

test('subdomain paths parse the short /{name} form and the legacy /packages/{name} mount', () => {
	expect(
		parsePackageAppSubdomainPath({ pathname: '/demo', username: 'alice' }),
	).toEqual({
		username: 'alice',
		kodyId: 'demo',
		restPath: '/',
		mount: 'user-subdomain',
	})
	expect(
		parsePackageAppSubdomainPath({
			pathname: '/demo/report/1',
			username: 'alice',
		}),
	).toMatchObject({ kodyId: 'demo', restPath: '/report/1' })
	expect(
		parsePackageAppSubdomainPath({
			pathname: '/packages/demo/report',
			username: 'alice',
		}),
	).toEqual({
		username: 'alice',
		kodyId: 'demo',
		restPath: '/report',
		mount: 'user-subdomain',
	})
})

test('subdomain paths never parse reserved first segments or a bare /packages', () => {
	for (const pathname of [
		'/',
		'/packages',
		'/packages/',
		'/-',
		'/-/health',
		'/-/auth/login',
		'/%2D/health',
		'/.well-known/security.txt',
		'/_kody/auth/login',
		'/@alice/webhooks/demo',
		'/robots.txt',
		'/favicon.ico',
		'/sitemap.xml',
		'/.git/config',
		'/.svn/wc.db',
		'/.hg/requires',
		'/%E0%A4%A',
	]) {
		expect(
			parsePackageAppSubdomainPath({ pathname, username: 'alice' }),
		).toBeNull()
	}
})

// Existing serve tests exercise the local construction path (index/platform/
// runtime scripts that export PackageAppRuntimeBridge). Slim-origin forward
// coverage lives in package-app-serve-slim-origin.node.test.ts.
vi.mock('#worker/runtime-worker-service.ts', () => ({
	hasLocalPackageAppRuntimeBridge: () => true,
	getRuntimeWorkerService: () => null,
	requireLocalPackageAppRuntimeBridge: () => {
		throw new Error(
			'requireLocalPackageAppRuntimeBridge should not run in serve unit tests that mock buildPackageAppWorker',
		)
	},
	packageAppRuntimeBridgeMissingMessage: 'bridge-missing',
	packageAppRuntimeForwardUnavailableMessage: 'forward-unavailable',
}))

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getEntitySourceById: vi.fn(),
	loadPublishedEntityManifest: vi.fn(),
	buildPackageAppWorker: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	persistPublishedBundleArtifact: vi.fn(),
	createWorker: vi.fn(),
	packageRealtimeConnect: vi.fn(),
	beginRunRecord: vi.fn((..._args: Array<unknown>): unknown => undefined),
	finishRunRecord: vi.fn(async (..._args: Array<unknown>) => true),
	loadPublishedCredentialNeeds: vi.fn(
		async (..._args: Array<unknown>) => [] as Array<unknown>,
	),
	isPackageCredentialSuppliersEnabled: vi.fn(
		async (
			_input: Parameters<
				typeof CredentialSuppliersFlag.isPackageCredentialSuppliersEnabled
			>[0],
		) => false,
	),
	openCredentialClient: vi.fn(async (..._args: Array<unknown>) => ({
		token: 'credential-handle',
	})),
}))

vi.mock('#worker/run-records/service.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	beginRunRecord: (...args: Array<unknown>) =>
		mockModule.beginRunRecord(...args),
	finishRunRecord: (...args: Array<unknown>) =>
		mockModule.finishRunRecord(...args),
}))

vi.mock('#worker/package-registry/source.ts', async () => {
	const actual = await vi.importActual<typeof PackageSourceModule>(
		'#worker/package-registry/source.ts',
	)
	return {
		...actual,
		loadPackageSourceBySourceId: (...args: Array<unknown>) =>
			mockModule.loadPackageSourceBySourceId(...args),
	}
})

vi.mock('#worker/package-runtime/realtime-session.ts', () => ({
	packageRealtimeSessionRpc: () => ({
		connect: (...args: Array<unknown>) =>
			mockModule.packageRealtimeConnect(...args),
	}),
}))

vi.mock('#worker/credentials/credential-needs-closure.ts', () => ({
	loadPublishedCredentialNeeds: (...args: Array<unknown>) =>
		mockModule.loadPublishedCredentialNeeds(...args),
}))

vi.mock('#worker/credentials/credential-suppliers-flag.ts', () => ({
	isPackageCredentialSuppliersEnabled: (
		...args: Parameters<
			typeof CredentialSuppliersFlag.isPackageCredentialSuppliersEnabled
		>
	) => mockModule.isPackageCredentialSuppliersEnabled(...args),
}))

vi.mock('#worker/credentials/credential-client.ts', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('#worker/credentials/credential-client.ts')
		>()
	return {
		...actual,
		openCredentialClient: (...args: Array<unknown>) =>
			mockModule.openCredentialClient(...args),
	}
})

vi.mock(
	'#worker/package-runtime/package-app-authority.ts',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('#worker/package-runtime/package-app-authority.ts')
			>()
		return {
			...actual,
			createPackageAppVisitorPersonalRequest: vi.fn(async () => null),
		}
	},
)

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', async () => {
	const actual = await vi.importActual<Record<string, unknown>>(
		'#worker/package-runtime/published-bundle-artifacts.ts',
	)
	return {
		...actual,
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
		persistPublishedBundleArtifact: (...args: Array<unknown>) =>
			mockModule.persistPublishedBundleArtifact(...args),
	}
})

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createWorker: (...args: Array<unknown>) => mockModule.createWorker(...args),
	}),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (...args: Array<unknown>) =>
		mockModule.loadPublishedEntityManifest(...args),
	loadPublishedEntitySource: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-app.ts', () => ({
	createPackageAppCallerContext: async (input: {
		user: { userId: string; email: string; displayName: string }
	}) => ({
		user: input.user,
	}),
	buildPackageAppWorker: (...args: Array<unknown>) =>
		mockModule.buildPackageAppWorker(...args),
}))

type FixtureOptions = {
	kodyId?: string
	app?: Record<string, string>
}

function createFixture(options: FixtureOptions = {}) {
	const kodyId = options.kodyId ?? 'perf-app'
	const app = options.app ?? { entry: './src/app.ts' }
	const sourceId = `source-${kodyId}`
	const savedPackage = {
		id: `pkg-${kodyId}`,
		userId: ownerIdFromStored('user-1'),
		name: `@demo-user/${kodyId}`,
		kodyId,
		description: 'Minimal hello-world app',
		tags: [],
		searchText: null,
		sourceId,
		hasApp: true,
		hidden: true,
		isPrivate: true,
		isInternetVisible: false,
		createdAt: '2026-08-12T00:00:00.000Z',
		updatedAt: '2026-08-12T00:00:00.000Z',
	}
	const source = {
		id: sourceId,
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package' as const,
		entity_id: savedPackage.id,
		repo_id: `repo-${kodyId}`,
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-08-12T00:00:00.000Z',
		updated_at: '2026-08-12T00:00:00.000Z',
	}
	const manifestContent = JSON.stringify({
		name: `@demo-user/${kodyId}`,
		private: true,
		exports: { '.': './src/index.ts' },
		kody: {
			id: kodyId,
			description: 'Minimal hello-world app',
			app,
		},
	})
	return { savedPackage, source, manifestContent }
}

function seedFixture(options?: FixtureOptions) {
	const fixture = createFixture(options)
	mockModule.isPackageCredentialSuppliersEnabled.mockResolvedValue(false)
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([])
	mockModule.openCredentialClient.mockResolvedValue({
		token: 'credential-handle',
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (_db: unknown, input: { userId: string; ref: string }) =>
			input.userId === fixture.savedPackage.userId &&
			input.ref === fixture.savedPackage.kodyId
				? fixture.savedPackage
				: null,
	)
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			sourceId === fixture.source.id ? fixture.source : null,
	)
	mockModule.loadPublishedEntityManifest.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId !== fixture.source.id) {
				throw new Error(`No manifest for ${input.sourceId}`)
			}
			return { source: fixture.source, content: fixture.manifestContent }
		},
	)
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					return new Response('ok')
				},
			}),
		},
	})
	return fixture
}

async function serveHelloWorld(input?: {
	kodyId?: string
	restPath?: string
	init?: RequestInit
	dispatch?: { synthetic: true }
	mount?: 'username-path' | 'user-subdomain'
}) {
	const kodyId = input?.kodyId ?? 'perf-app'
	const restPath = input?.restPath ?? '/'
	const mount = input?.mount ?? 'username-path'
	const requestPath =
		mount === 'user-subdomain'
			? `/${kodyId}${restPath === '/' ? '' : restPath}`
			: `/@demo-user/packages/${kodyId}${restPath === '/' ? '' : restPath}`
	const requestOrigin =
		mount === 'user-subdomain'
			? 'https://demo-user.kody.run'
			: 'https://example.com'
	return await servePackageAppRequest({
		request: new Request(`${requestOrigin}${requestPath}`, input?.init),
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as Env,
		owner: {
			userId: ownerIdFromStored('user-1'),
			username: 'demo-user',
			email: 'demo-user@example.com',
			displayName: 'Demo User',
		},
		visitor: {
			userId: personIdFromStored('user-1'),
			username: 'demo-user',
			role: 'owner',
		},
		packagePath: {
			username: 'demo-user',
			kodyId,
			restPath,
			mount,
		},
		dispatch: input?.dispatch,
	})
}

test('required executor credentials redirect visitors to consent before serving app content', async () => {
	seedFixture()
	mockModule.isPackageCredentialSuppliersEnabled.mockResolvedValue(true)
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([
		{
			key: 'calendar',
			kind: 'oauth',
			provider: 'google',
			description: 'Read the calendar',
			supplier: 'executor',
			required: true,
			multiple: false,
		},
	])
	mockModule.openCredentialClient.mockRejectedValue(
		new CredentialClientError({
			code: 'credential_unbound',
			message: 'No credential is mapped.',
			retryWith: [],
		}),
	)

	const response = await serveHelloWorld()
	const location = response.headers.get('location')
	expect(response.status).toBe(302)
	expect(location).not.toBeNull()
	const loginUrl = new URL(location!)
	expect(loginUrl.pathname).toBe('/-/auth/login')
	expect(loginUrl.searchParams.get('scope')).toBe('profile need:calendar')
	expect(loginUrl.searchParams.get('prompt')).toBe('consent')
	expect(loginUrl.searchParams.get('app')).toBe('perf-app')
	expect(loginUrl.searchParams.get('return_to')).toBe(
		'/@demo-user/packages/perf-app',
	)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('required executor consent redirect identifies the app on a user-subdomain mount', async () => {
	seedFixture()
	mockModule.isPackageCredentialSuppliersEnabled.mockResolvedValue(true)
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([
		{
			key: 'calendar',
			kind: 'oauth',
			provider: 'google',
			description: 'Read the calendar',
			supplier: 'executor',
			required: true,
			multiple: false,
		},
	])
	mockModule.openCredentialClient.mockRejectedValue(
		new CredentialClientError({
			code: 'credential_unbound',
			message: 'No credential is mapped.',
			retryWith: [],
		}),
	)

	const response = await serveHelloWorld({ mount: 'user-subdomain' })
	const location = response.headers.get('location')
	expect(response.status).toBe(302)
	expect(location).not.toBeNull()
	const loginUrl = new URL(location!)
	expect(loginUrl.hostname).toBe('demo-user.kody.run')
	expect(loginUrl.searchParams.get('app')).toBe('perf-app')
})

test('required executor credential failures do not redirect non-GET requests', async () => {
	seedFixture()
	mockModule.isPackageCredentialSuppliersEnabled.mockResolvedValue(true)
	mockModule.loadPublishedCredentialNeeds.mockResolvedValue([
		{
			key: 'calendar',
			kind: 'oauth',
			provider: 'google',
			description: 'Read the calendar',
			supplier: 'executor',
			required: true,
			multiple: false,
		},
	])
	mockModule.openCredentialClient.mockRejectedValue(
		new CredentialClientError({
			code: 'credential_unbound',
			message: 'No credential is mapped.',
			retryWith: [],
		}),
	)
	consoleError.mockImplementation(() => {})

	const response = await serveHelloWorld({
		init: { method: 'POST', body: 'request-body' },
	})

	expect(response.status).not.toBe(302)
	expect(response.headers.get('location')).toBeNull()
	expect(await response.text()).toContain('Package app could not be prepared')
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'Package app handler failed:',
		expect.objectContaining({
			body: expect.objectContaining({ code: 'credential_unbound' }),
		}),
	)
})

const clientModuleName = 'client.0123456789abcdef.js'

const clientAppKodyId = 'client-app'

function withApp(manifestContent: string, app: Record<string, string>) {
	const manifest = JSON.parse(manifestContent)
	return JSON.stringify({ ...manifest, kody: { ...manifest.kody, app } })
}

function stubFreshSource(
	source: unknown,
	manifestContent: string,
	files: Record<string, string>,
) {
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source,
		manifest: JSON.parse(manifestContent),
		files: {
			'package.json': manifestContent,
			'src/app.ts': 'export default { fetch() { return new Response("ok") } }',
			...files,
		},
	})
}

function seedClientAndAssets() {
	const fixture = seedFixture({
		kodyId: clientAppKodyId,
		app: {
			entry: './src/app.ts',
			client: './src/client.ts',
			assets: './public',
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: { kind: string; entryPoint: string }) =>
			input.kind === 'app-client' && input.entryPoint === 'src/client.ts'
				? {
						row: {
							id: 'row-client',
							publishedCommit: fixture.source.published_commit,
						},
						artifact: {
							mainModule: clientModuleName,
							modules: { [clientModuleName]: 'export const hello = "hi"' },
							publishedCommit: fixture.source.published_commit,
						},
					}
				: null,
	)
	stubFreshSource(fixture.source, fixture.manifestContent, {
		'src/client.ts': 'export const hello = "hi"',
		'public/styles.css': 'body { color: red }',
		'public/img/dot.png': '\u0089PNG\r\n\u001a\n',
		'public/client.production.js': 'console.log("static, not the bundle")',
	})
	return fixture
}

function asset(path: string, init?: RequestInit, kodyId = clientAppKodyId) {
	return serveHelloWorld({ kodyId, restPath: `/_assets/${path}`, init })
}

test('createPackageCodeRequest strips credentials and filters package cookies', () => {
	const prefix = '__kapp_123456789abc_'
	const request = createPackageCodeRequest(
		new Request('https://example.com/app', {
			headers: {
				Cookie: `${prefix}a=1; kody_session=x; __kapp_sibling_b=2`,
				Authorization: 'Bearer secret',
				'Proxy-Authorization': 'Bearer secret',
				'X-Kody-Visitor': 'forged',
			},
		}),
		'https://example.com/app',
		{ cookiePrefix: prefix },
	)
	expect(request.headers.get('Cookie')).toBe(`${prefix}a=1`)
	expect(request.headers.has('Authorization')).toBe(false)
	expect(request.headers.has('Proxy-Authorization')).toBe(false)
	expect(request.headers.has('X-Kody-Visitor')).toBe(false)
})

test('createPackageCodeRequest keeps deleting cookies without a package prefix', () => {
	const request = createPackageCodeRequest(
		new Request('https://example.com/app', {
			headers: { Cookie: 'session=value' },
		}),
	)
	expect(request.headers.has('Cookie')).toBe(false)
})

test('package app request cookies allow own, Host, and Secure cookie prefixes only', () => {
	expect(
		filterPackageAppRequestCookies(
			[
				'__kapp_123456789abc_session=1',
				'__Host-__kapp_123456789abc_host=2',
				'__Secure-__kapp_123456789abc_secure=3',
				'kody_session=x',
				'__Host-kody_pkg_session_hash=x',
				'__kapp_sibling_other=4',
			].join('; '),
			'__kapp_123456789abc_',
		),
	).toBe(
		'__kapp_123456789abc_session=1; __Host-__kapp_123456789abc_host=2; __Secure-__kapp_123456789abc_secure=3',
	)
})

test('package-app serve filters response cookies and inbound cookies by package id', async () => {
	const fixture = seedFixture()
	const prefix = await packageAppCookiePrefix(fixture.savedPackage.id)
	let appCookie: string | null = null
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch(request: Request) {
					appCookie = request.headers.get('Cookie')
					return new Response('ok', {
						headers: [
							['Set-Cookie', `${prefix}a=1; Path=/; HttpOnly`],
							['Set-Cookie', 'other=1; Path=/'],
						],
					})
				},
			}),
		},
	})
	consoleWarn.mockImplementation(() => {})
	const response = await serveHelloWorld({
		init: {
			headers: {
				Cookie: `${prefix}a=1; kody_session=x; __kapp_000000000000_b=2`,
			},
		},
	})
	expect(appCookie).toBe(`${prefix}a=1`)
	expect(response.headers.getSetCookie()).toEqual([
		`${prefix}a=1; Path=/; HttpOnly`,
	])
	expect(consoleWarn).toHaveBeenCalledWith(
		'package-app-set-cookie-name-dropped',
		expect.objectContaining({ dropped: ['other'] }),
	)
})

test('package-app serve dispatches cold and warm requests', async () => {
	seedFixture({ kodyId: 'warm-cache-app' })

	const cold = await serveHelloWorld()
	expect(cold.status).toBe(200)
	expect(await cold.text()).toBe('ok')
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalledTimes(1)

	mockModule.buildPackageAppWorker.mockClear()
	const warm = await serveHelloWorld()

	expect(warm.status).toBe(200)
	expect(await warm.text()).toBe('ok')
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalledTimes(1)
})

test('websocket upgrade responses skip Server-Timing and keep the paired socket', async () => {
	seedFixture()
	const client = { kind: 'client-socket' } as unknown as WebSocket
	// Node's Response rejects status 101; Workers still pair via `webSocket`.
	const upgradeResponse = new Response(null, { status: 200 })
	upgradeResponse.headers.append('Set-Cookie', 'other=1; Path=/')
	Object.defineProperty(upgradeResponse, 'webSocket', {
		value: client,
		configurable: true,
	})
	mockModule.packageRealtimeConnect.mockResolvedValue(upgradeResponse)

	consoleWarn.mockImplementation(() => {})
	consoleError.mockImplementation(() => {})
	const response = await serveHelloWorld({
		restPath: '/ws',
		init: {
			headers: {
				Upgrade: 'websocket',
				Connection: 'Upgrade',
			},
		},
	})

	expect(response.webSocket).toBe(client)
	expect(response.headers.getSetCookie()).toEqual([])
	// DO upgrade responses have immutable headers; attaching timing would throw
	// or force an unsafe rebuild. Skip Server-Timing on websocket upgrades.
	expect(response.headers.get('Server-Timing')).toBeNull()
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('package-app host permanent-308s a retired slug to the current leaf', async () => {
	const fixture = createFixture({ kodyId: 'new-app' })
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (
			_db: unknown,
			input: {
				userId: string
				ref: string
				match?: string
				followRedirects?: boolean
			},
		) => {
			if (input.userId !== fixture.savedPackage.userId) return null
			if (input.ref === 'new-app') return fixture.savedPackage
			if (input.ref === 'old-app' && input.followRedirects) {
				return fixture.savedPackage
			}
			return null
		},
	)

	const redirected = await serveHelloWorld({
		kodyId: 'old-app',
		restPath: '/dashboard',
	})
	expect(redirected.status).toBe(308)
	expect(redirected.headers.get('Location')).toBe(
		'/@demo-user/packages/new-app/dashboard',
	)
	expect(redirected.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					return new Response('ok')
				},
			}),
		},
	})
	mockModule.getEntitySourceById.mockResolvedValue(fixture.source)
	mockModule.loadPublishedEntityManifest.mockResolvedValue({
		source: fixture.source,
		content: fixture.manifestContent,
	})
	const current = await serveHelloWorld({ kodyId: 'new-app' })
	expect(current.status).toBe(200)
	expect(await current.text()).toBe('ok')
})

test('package-app 308 Location uses the name leaf when kodyId diverges', async () => {
	const fixture = createFixture({ kodyId: 'stale-kody-id' })
	fixture.savedPackage.name = '@demo-user/canonical-leaf'
	mockModule.resolveSavedPackageRef.mockImplementation(
		async (
			_db: unknown,
			input: {
				userId: string
				ref: string
				followRedirects?: boolean
			},
		) => {
			if (input.userId !== fixture.savedPackage.userId) return null
			if (input.ref === 'diverged-old-app' && input.followRedirects) {
				return fixture.savedPackage
			}
			return null
		},
	)

	const redirected = await serveHelloWorld({ kodyId: 'diverged-old-app' })
	expect(redirected.status).toBe(308)
	expect(redirected.headers.get('Location')).toBe(
		'/@demo-user/packages/canonical-leaf',
	)
	expect(redirected.headers.get('Cache-Control')).toBe('no-store')
})

test('/_assets/ serves the fingerprinted client module with immutable caching and never builds the worker', async () => {
	seedClientAndAssets()

	const response = await asset(clientModuleName)
	expect(response.status).toBe(200)
	expect(Object.fromEntries(response.headers)).toMatchObject({
		'content-type': 'text/javascript; charset=utf-8',
		'cache-control': 'private, max-age=31536000, immutable',
		'x-content-type-options': 'nosniff',
		etag: `"${clientModuleName}"`,
	})
	expect(await response.text()).toBe('export const hello = "hi"')
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	const revalidated = await asset(clientModuleName, {
		headers: { 'If-None-Match': `"${clientModuleName}"` },
	})
	expect(revalidated.status).toBe(304)

	const stale = await asset('client.ffffffffffffffff.js')
	expect(stale.status).toBe(404)
	expect(stale.headers.get('Cache-Control')).toBe('no-store')

	// A static file whose name merely resembles a client module is not
	// shadowed by the fingerprinted-module fast path.
	const lookalike = await asset('client.production.js')
	expect(lookalike.status).toBe(200)
	expect(lookalike.headers.get('Content-Type')).toBe(
		'text/javascript; charset=utf-8',
	)
	expect(lookalike.headers.get('Cache-Control')).toBe('private, max-age=300')
	expect(await lookalike.text()).toBe('console.log("static, not the bundle")')
	// A service worker script in the assets directory may claim the whole app
	// mount as its scope; non-script assets do not carry the header.
	expect(lookalike.headers.get('Service-Worker-Allowed')).toBe(
		'/@demo-user/packages/client-app/',
	)
	expect(response.headers.get('Service-Worker-Allowed')).toBeNull()
	const css = await asset('styles.css')
	expect(css.headers.get('Service-Worker-Allowed')).toBeNull()
})

test('/_assets/__version.json exposes the current client module URL for service workers without caching', async () => {
	const fixture = seedClientAndAssets()

	const version = await asset('__version.json')
	expect(version.status).toBe(200)
	expect(version.headers.get('Content-Type')).toBe(
		'application/json; charset=utf-8',
	)
	expect(version.headers.get('Cache-Control')).toBe('private, no-cache')
	expect(version.headers.get('ETag')).toBe(
		`"${fixture.source.published_commit}:${clientModuleName}"`,
	)
	expect(await version.json()).toEqual({
		clientModuleUrl: `https://example.com/@demo-user/packages/${clientAppKodyId}/_assets/${clientModuleName}`,
		assetBasePath: `/@demo-user/packages/${clientAppKodyId}/_assets`,
		publishedCommit: fixture.source.published_commit,
	})
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	// Worker-only apps still answer, with a null module URL, so kit code can
	// probe one path regardless of manifest shape.
	seedFixture()
	const workerOnly = await asset('__version.json', undefined, 'perf-app')
	expect(workerOnly.status).toBe(200)
	expect(await workerOnly.json()).toMatchObject({
		clientModuleUrl: null,
		assetBasePath: '/@demo-user/packages/perf-app/_assets',
	})
})

test('/_assets/ serves files from the declared assets directory with inferred content types', async () => {
	const fixture = seedClientAndAssets()

	const css = await asset('styles.css')
	expect(css.status).toBe(200)
	expect(css.headers.get('Content-Type')).toBe('text/css; charset=utf-8')
	expect(css.headers.get('Cache-Control')).toBe('private, max-age=300')
	expect(css.headers.get('ETag')).toBe(
		`"${fixture.source.published_commit}:public/styles.css"`,
	)
	expect(await css.text()).toBe('body { color: red }')

	const png = await asset('img/dot.png')
	expect(png.status).toBe(200)
	expect(png.headers.get('Content-Type')).toBe('image/png')
	expect(png.headers.get('X-Content-Type-Options')).toBe('nosniff')
	// PNG magic must survive the serve path byte-identical. A UTF-8 decode of
	// the snapshot would turn leading 0x89 into U+FFFD → served 0xFD.
	const pngBytes = [...new Uint8Array(await png.arrayBuffer())]
	expect(pngBytes.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47])
	expect(pngBytes).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

	const head = await asset('styles.css', { method: 'HEAD' })
	expect(head.status).toBe(200)
	expect(head.headers.get('Content-Length')).toBe('19')
	expect(await head.text()).toBe('')

	for (const [path, init, status] of [
		['missing.txt', undefined, 404],
		['../package.json', undefined, 404],
		['%2e%2e/package.json', undefined, 404],
		['styles.css', { method: 'POST' }, 405],
	] as const) {
		expect((await asset(path, init)).status).toBe(status)
	}
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})

test('/_assets/ repairs a missing published client artifact from fresh source and persists it under the fresh row', async () => {
	const repairKodyId = 'repair-app'
	const fixture = seedFixture({
		kodyId: repairKodyId,
		app: { entry: './src/app.ts', client: './src/client.ts' },
	})
	// The cached manifest still says ./src/client.ts; the source files (and
	// the D1 row) have moved on to a republish that renamed the entry.
	const freshSource = { ...fixture.source, published_commit: 'commit-2' }
	mockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) =>
			sourceId === fixture.source.id ? freshSource : null,
	)
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	mockModule.persistPublishedBundleArtifact.mockResolvedValue('kv-key')
	mockModule.createWorker.mockResolvedValue({
		mainModule: 'bundle.js',
		modules: { 'bundle.js': 'console.log("rebuilt");\n' },
	})
	stubFreshSource(
		freshSource,
		withApp(fixture.manifestContent, {
			entry: './src/app.ts',
			client: './src/browser.ts',
		}),
		{ 'src/browser.ts': 'console.log("rebuilt")' },
	)

	const probe = await asset(
		'client.0000000000000000.js',
		undefined,
		repairKodyId,
	)
	// The requested hash is stale, but the repair still happens so the next
	// page render can hand out the fresh URL.
	expect(probe.status).toBe(404)
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(mockModule.createWorker).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/browser.ts' }),
	)
	expect(mockModule.persistPublishedBundleArtifact).toHaveBeenCalledWith(
		expect.objectContaining({
			kind: 'app-client',
			artifactName: null,
			entryPoint: 'src/browser.ts',
			source: freshSource,
			mainModule: expect.stringMatching(/^client\.[A-Za-z0-9_-]{16}\.js$/),
		}),
	)
	const persisted = mockModule.persistPublishedBundleArtifact.mock
		.calls[0]?.[0] as { mainModule: string }

	const served = await asset(persisted.mainModule, undefined, repairKodyId)
	expect(served.status).toBe(200)
	expect(await served.text()).toBe('console.log("rebuilt");\n')
	// Warm: the artifact cache answers without another bundle or KV lookup.
	expect(mockModule.createWorker).toHaveBeenCalledTimes(1)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).toHaveBeenCalledTimes(1)
})

test('/_assets/ treats a client entry removed by a republish as no client', async () => {
	const removedKodyId = 'removed-client-app'
	const fixture = seedFixture({
		kodyId: removedKodyId,
		app: { entry: './src/app.ts', client: './src/client.ts' },
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	stubFreshSource(
		fixture.source,
		withApp(fixture.manifestContent, { entry: './src/app.ts' }),
		{},
	)

	const response = await asset(
		'client.0000000000000000.js',
		undefined,
		removedKodyId,
	)
	expect(response.status).toBe(404)
	expect(mockModule.createWorker).not.toHaveBeenCalled()
	expect(mockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
})

test('/_assets/ is a 404 for apps without client or assets and author fetch still handles other paths', async () => {
	seedFixture()

	expect((await asset('anything.js', undefined, 'perf-app')).status).toBe(404)
	expect(
		mockModule.loadPublishedBundleArtifactByIdentity,
	).not.toHaveBeenCalled()
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()

	const page = await serveHelloWorld({ restPath: '/assets/anything.js' })
	expect(page.status).toBe(200)
	expect(await page.text()).toBe('ok')
	expect(mockModule.buildPackageAppWorker).toHaveBeenCalledTimes(1)
})

test('OPTIONS that the app answers is forwarded unchanged', async () => {
	seedFixture({ kodyId: 'options-handled-app' })
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch(request: Request) {
					expect(request.method).toBe('OPTIONS')
					return new Response(null, {
						status: 204,
						headers: { 'access-control-allow-origin': '*' },
					})
				},
			}),
		},
	})

	const response = await serveHelloWorld({
		kodyId: 'options-handled-app',
		init: { method: 'OPTIONS' },
	})
	expect(response.status).toBe(204)
	expect(response.headers.get('access-control-allow-origin')).toBe('*')
	expect(response.headers.get('server-timing')).toContain('entrypoint')
})

test('an OPTIONS handler throw becomes a 204, not the package-entrypoint page', async () => {
	consoleError.mockImplementation(() => {})
	seedFixture({ kodyId: 'options-throw-app' })
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					return new Response(null, {
						status: 500,
						headers: {
							[packageAppRuntimeErrorHeader]: '1',
							[packageAppRuntimeRunIdHeader]: 'run-options-1',
						},
					})
				},
			}),
		},
	})

	const response = await serveHelloWorld({
		kodyId: 'options-throw-app',
		init: {
			method: 'OPTIONS',
			headers: { Accept: 'application/json' },
		},
	})
	expect(response.status).toBe(204)
	expect(response.headers.get('Allow')).toContain('OPTIONS')
	expect(response.headers.get(packageAppRuntimeErrorHeader)).toBeNull()
	await expect(response.text()).resolves.toBe('')
	expect(consoleError).not.toHaveBeenCalledWith(
		'package-app-http-error',
		expect.anything(),
	)
})

test('a tagged runtime throw becomes the package-entrypoint page with the run id', async () => {
	consoleError.mockImplementation(() => {})
	seedFixture({ kodyId: 'runtime-throw-app' })
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					return new Response(null, {
						status: 500,
						headers: {
							[packageAppRuntimeErrorHeader]: '1',
							[packageAppRuntimeRunIdHeader]: 'run-thrown-1',
						},
					})
				},
			}),
		},
	})

	const response = await serveHelloWorld({
		kodyId: 'runtime-throw-app',
		init: { headers: { Accept: 'application/json' } },
	})
	expect(response.status).toBe(500)
	expect(response.headers.get(packageAppRuntimeErrorHeader)).toBeNull()
	expect(response.headers.get(packageAppRuntimeRunIdHeader)).toBeNull()
	await expect(response.json()).resolves.toMatchObject({
		error: 'Package app crashed',
		package: { kody_id: 'runtime-throw-app' },
	})
	const logged = consoleError.mock.calls.find(
		(call) => call[0] === 'package-app-http-error',
	)
	expect(logged?.[1]).toMatchObject({
		status: 500,
		phase: 'package-entrypoint',
		runtimeRunId: 'run-thrown-1',
	})
})

test('an entrypoint rejection records an owner-visible error run and shows its id and ray on the crash page', async () => {
	// The app worker can fail before its wrapper starts a run (no runList
	// entry, app try/catch never runs). The host records the run instead.
	consoleError.mockImplementation(() => {})
	seedFixture({ kodyId: 'entrypoint-reject-app' })
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					throw new Error('internal platform detail')
				},
			}),
		},
	})
	mockModule.beginRunRecord.mockImplementation((...args: Array<unknown>) => ({
		id: 'host-run-1',
		context: (args[0] as { context: unknown }).context,
	}))
	mockModule.finishRunRecord.mockClear()

	const response = await serveHelloWorld({
		kodyId: 'entrypoint-reject-app',
		restPath: '/items',
		init: { headers: { Accept: 'application/json' } },
	})
	expect(response.status).toBe(500)
	await expect(response.json()).resolves.toMatchObject({
		error: 'Package app crashed',
		run_id: 'host-run-1',
	})
	expect(mockModule.beginRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			context: expect.objectContaining({
				packageId: 'pkg-entrypoint-reject-app',
				surface: 'app_fetch',
				name: '/items',
				publishedCommit: 'commit-1',
				metadata: expect.objectContaining({ phase: 'package-entrypoint' }),
			}),
		}),
	)
	expect(mockModule.finishRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'error',
			handle: expect.objectContaining({ id: 'host-run-1' }),
		}),
	)
	const finished = mockModule.finishRunRecord.mock.calls[0]?.[0] as unknown as {
		error: Error
	}
	// Host exception text stays internal.
	expect(finished.error.message).not.toContain('internal platform detail')

	// The HTML crash page shows the run id and the request's Cloudflare ray.
	const htmlWithRun = await serveHelloWorld({
		kodyId: 'entrypoint-reject-app',
		init: { headers: { 'cf-ray': '8f00aa11bb22cc33-DEN' } },
	})
	expect(htmlWithRun.status).toBe(500)
	const pageWithRun = await htmlWithRun.text()
	expect(pageWithRun).toMatch(
		/<dt>Run ID<\/dt>\s*<dd><code>host-run-1<\/code><\/dd>/,
	)
	expect(pageWithRun).toMatch(
		/<dt>Ray ID<\/dt>\s*<dd><code>8f00aa11bb22cc33-DEN<\/code><\/dd>/,
	)
	expect(pageWithRun).not.toContain('internal platform detail')

	// No run recorded and no well-formed ray: neither row is shown.
	mockModule.beginRunRecord.mockReset()
	const html = await serveHelloWorld({
		kodyId: 'entrypoint-reject-app',
		init: { headers: { 'cf-ray': '<script>' } },
	})
	expect(html.status).toBe(500)
	const page = await html.text()
	expect(page).toContain('Package app crashed')
	expect(page).not.toContain('Run ID')
	expect(page).not.toContain('Ray ID')
})

test('author 200 responses that set the runtime-error header stay successful', async () => {
	seedFixture({ kodyId: 'author-marker-app' })
	mockModule.buildPackageAppWorker.mockResolvedValue({
		entrypointName: 'PackageAppWorker',
		visit: { ticket: null, nonce: null },
		stub: {
			getEntrypoint: () => ({
				async fetch() {
					return new Response('ok', {
						status: 200,
						headers: { [packageAppRuntimeErrorHeader]: '1' },
					})
				},
			}),
		},
	})

	const response = await serveHelloWorld({ kodyId: 'author-marker-app' })
	expect(response.status).toBe(200)
	expect(await response.text()).toBe('ok')
	expect(consoleError).not.toHaveBeenCalledWith(
		'package-app-http-error',
		expect.anything(),
	)
})

test('synthetic host-setup failures return JSON with the underlying cause', async () => {
	consoleError.mockImplementation(() => {})
	seedFixture({ kodyId: 'prep-fail-app' })
	mockModule.buildPackageAppWorker.mockRejectedValueOnce(
		new Error(
			'kody.app.runtime was removed; every package app is a fetch handler',
		),
	)

	const response = await serveHelloWorld({
		kodyId: 'prep-fail-app',
		dispatch: { synthetic: true },
	})
	expect(response.status).toBe(500)
	expect(response.headers.get('content-type')).toContain('application/json')
	await expect(response.json()).resolves.toEqual({
		error: 'Package app could not be prepared',
		message:
			'Kody could not load or prepare this package app runtime before your request reached the package code.',
		next_step:
			'This has been reported to Kody. Try again shortly, or ask the package owner to republish the package if it keeps happening.',
		package: {
			name: '@demo-user/prep-fail-app',
			kody_id: 'prep-fail-app',
		},
		request_path: '/@demo-user/packages/prep-fail-app',
		cause: 'kody.app.runtime was removed; every package app is a fetch handler',
	})
})

test('an app past the monthly include with no credits gets a 429 pause page, not a reported failure', async () => {
	seedFixture({ kodyId: 'include-used-up-app' })
	const overage = (resource: string, limit: number) =>
		new ComputeOverageLimitError({
			resource,
			plan: 'pro',
			limit,
			current: limit + 1,
			creditsStatus: 'add_credits',
		} as ConstructorParameters<typeof ComputeOverageLimitError>[0])
	mockModule.buildPackageAppWorker.mockRejectedValueOnce(
		overage('unique_worker_days', 350),
	)

	const html = await serveHelloWorld({ kodyId: 'include-used-up-app' })
	expect(html.status).toBe(429)
	const page = await html.text()
	expect(page).toContain('Monthly include used up')
	expect(page).toContain('Add credits at /account/usage#credits to keep going')
	expect(page).toContain('data-error-agent-prompt')
	expect(page).toContain('Copy prompt for your agent')
	expect(consoleError).not.toHaveBeenCalled()

	mockModule.buildPackageAppWorker.mockRejectedValueOnce(
		overage('durable_object_rows_read', 5_000_000_000),
	)
	const json = await serveHelloWorld({
		kodyId: 'include-used-up-app',
		dispatch: { synthetic: true },
	})
	expect(json.status).toBe(429)
	await expect(json.json()).resolves.toMatchObject({
		error: 'Monthly include used up',
		cause: expect.stringContaining('Rows read include used up'),
	})
})

test('missing published runtime bundle returns 503 without reporting a host-setup failure', async () => {
	consoleError.mockImplementation(() => {})
	seedFixture({ kodyId: 'runtime-bundle-pending-app' })
	const pending = new Error(
		'Saved package app "runtime-bundle-pending-app" declares npm dependencies ("kleur") but no published runtime bundle artifact is available yet. Republish the package so Kody can install dependencies and persist a fresh runtime bundle artifact.',
	)
	mockModule.buildPackageAppWorker.mockRejectedValueOnce(pending)

	const html = await serveHelloWorld({ kodyId: 'runtime-bundle-pending-app' })
	expect(html.status).toBe(503)
	const page = await html.text()
	expect(page).toContain('Package app is still preparing')
	expect(page).toContain('Try again shortly')
	expect(page).toContain('data-error-agent-prompt')
	// Expected transient: structured 503 log only (no platform "handler failed"
	// console.error). Stuck rebuilds stay visible via these logs + publish
	// rebuild failures; invoke already returns the same class as 503.
	expect(consoleError).toHaveBeenCalledWith(
		'package-app-http-error',
		expect.objectContaining({
			status: 503,
			phase: 'runtime-bundle-pending',
			pathname: '/@demo-user/packages/runtime-bundle-pending-app',
		}),
	)
	expect(consoleError).not.toHaveBeenCalledWith(
		'Package app handler failed:',
		expect.anything(),
	)

	mockModule.buildPackageAppWorker.mockRejectedValueOnce(pending)
	const json = await serveHelloWorld({
		kodyId: 'runtime-bundle-pending-app',
		dispatch: { synthetic: true },
	})
	expect(json.status).toBe(503)
	await expect(json.json()).resolves.toMatchObject({
		error: 'Package app is still preparing',
		message: expect.stringContaining('not ready yet'),
		next_step: expect.stringContaining('Try again shortly'),
		cause: pending.message,
	})
})

test('custom hostnames mount the bound app at the host root', () => {
	expect(
		parsePackageAppCustomHostnamePath({
			pathname: '/',
			username: 'pkg-owner',
			kodyId: 'demo',
		}),
	).toEqual({
		username: 'pkg-owner',
		kodyId: 'demo',
		restPath: '/',
		mount: 'custom-hostname',
	})
	expect(
		parsePackageAppCustomHostnamePath({
			pathname: '',
			username: 'pkg-owner',
			kodyId: 'demo',
		}).restPath,
	).toBe('/')
	expect(
		parsePackageAppCustomHostnamePath({
			pathname: '/report/today',
			username: 'pkg-owner',
			kodyId: 'demo',
		}).restPath,
	).toBe('/report/today')
})

test('VCS probe paths 404 before building the package-app worker', async () => {
	seedFixture({ kodyId: 'probe-app' })
	mockModule.buildPackageAppWorker.mockClear()
	const response = await servePackageAppRequest({
		request: new Request('https://app.example/.git/config'),
		env: {
			APP_DB: {},
			BUNDLE_ARTIFACTS_KV: {},
		} as Env,
		owner: {
			userId: ownerIdFromStored('user-1'),
			username: 'demo-user',
			email: 'demo-user@example.com',
			displayName: 'Demo User',
		},
		visitor: null,
		packagePath: {
			username: 'demo-user',
			kodyId: 'probe-app',
			restPath: '/.git/config',
			mount: 'custom-hostname',
		},
	})
	expect(response.status).toBe(404)
	expect(mockModule.buildPackageAppWorker).not.toHaveBeenCalled()
})
