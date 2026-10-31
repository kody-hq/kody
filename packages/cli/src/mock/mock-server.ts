/**
 * Lightweight in-process mock of the Kody production API for `--target mock`.
 * Does not ship or require kody-celld. Refuses unimplemented routes/ops with
 * `not_implemented_in_mock` rather than faking success.
 */

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from 'node:http'
import { type AddressInfo } from 'node:net'
import {
	notImplementedInMock,
	StructuredCliError,
} from '../structured-error.js'
import { unmockedRequestError } from './mock-fetch-gateway.js'
import {
	isMockCapabilityPath,
	isMockOpenApiOperation,
	mockOpenApiOperationIds,
} from './mock-supported.js'
import {
	closePackageSqlDbsForSession,
	defaultMockSessionId,
	loadMockSession,
	packageStorageDelete,
	packageStorageGet,
	packageStorageList,
	packageStorageSet,
	packageStorageSql,
	persistMockSession,
	type MockSessionState,
} from './mock-storage.js'

export type MockServerOptions = {
	sessionId?: string
	resetStorage?: boolean
	host?: string
	port?: number
	/** Fixed package id for scratch packageStorage in local package runs. */
	packageId?: string
	/** `--org` slug reflected by metaGetCurrentUser on mock. */
	orgSlug?: string
	env?: NodeJS.ProcessEnv
}

export type MockServer = {
	url: string
	port: number
	sessionId: string
	close: () => Promise<void>
	state: () => MockSessionState
}

const mockTokenPrefix = 'kody_mock_'

export function isMockApiToken(token: string): boolean {
	return token.startsWith(mockTokenPrefix) || token === 'mock'
}

/** Issue a bearer the mock accepts (never a real kody_at_…). */
export function mintMockApiToken(sessionId: string): string {
	return `${mockTokenPrefix}${sessionId}`
}

export async function startMockServer(
	options: MockServerOptions = {},
): Promise<MockServer> {
	const sessionIdForClose =
		options.sessionId?.trim() ||
		defaultMockSessionId(options.env ?? process.env)
	if (options.resetStorage) {
		// Close SQLite handles before wiping the session directory so reset
		// does not leave a live connection to a deleted file.
		closePackageSqlDbsForSession(sessionIdForClose)
	}
	let state = await loadMockSession({
		sessionId: options.sessionId,
		env: options.env,
		reset: options.resetStorage,
	})
	const packageId = options.packageId ?? `local-${state.sessionId}`
	const orgSlug = options.orgSlug?.trim() || 'mock-org'
	const env = options.env

	const server = createServer((req, res) => {
		void handleRequest(req, res, {
			getState: () => state,
			setState: async (next) => {
				state = next
				await persistMockSession(state, env)
			},
			packageId,
			orgSlug,
			env,
		})
	})

	const host = options.host ?? '127.0.0.1'
	const port = options.port ?? 0
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => resolve())
	})
	const address = server.address() as AddressInfo
	const url = `http://${host}:${address.port}`

	return {
		url,
		port: address.port,
		sessionId: state.sessionId,
		state: () => state,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => {
					// Windows keeps an open SQLite file locked against cleanup.
					closePackageSqlDbsForSession(sessionIdForClose)
					if (error) reject(error)
					else resolve()
				})
				// Idle keep-alive sockets (workerd's bridge calls) would hold close open.
				server.closeAllConnections()
			}),
	}
}

/** Ensure a mock is running and return its API origin + token for CLI wiring. */
export async function ensureMockTarget(input: {
	sessionId?: string
	resetStorage?: boolean
	packageId?: string
	orgSlug?: string
	env?: NodeJS.ProcessEnv
	/** Reuse an already-started server (e.g. long-lived `kody dev`). */
	existing?: MockServer
}): Promise<{
	apiUrl: string
	token: string
	server: MockServer
	started: boolean
}> {
	if (input.existing) {
		return {
			apiUrl: input.existing.url,
			token: mintMockApiToken(input.existing.sessionId),
			server: input.existing,
			started: false,
		}
	}
	const server = await startMockServer({
		sessionId: input.sessionId,
		resetStorage: input.resetStorage,
		packageId: input.packageId,
		orgSlug: input.orgSlug,
		env: input.env,
	})
	return {
		apiUrl: server.url,
		token: mintMockApiToken(server.sessionId),
		server,
		started: true,
	}
}

type RequestCtx = {
	getState: () => MockSessionState
	setState: (state: MockSessionState) => Promise<void>
	packageId: string
	orgSlug: string
	env?: NodeJS.ProcessEnv
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	ctx: RequestCtx,
): Promise<void> {
	try {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		const method = (req.method ?? 'GET').toUpperCase()
		const body = await readJsonBody(req)
		const requestOrg = url.searchParams.get('org')?.trim() || undefined
		const effectiveOrg = requestOrg || ctx.orgSlug
		const callCtx: RequestCtx = { ...ctx, orgSlug: effectiveOrg }

		if (method === 'GET' && url.pathname === '/openapi.json') {
			return sendJson(res, 200, mockOpenApiDocument())
		}

		if (method === 'GET' && url.pathname === '/v1/capability-proxy/session') {
			assertMockAuth(req)
			return sendJson(res, 200, {
				scopes: [
					'org:execute',
					'org:read',
					'package:execute',
					'package:read',
					'search:read',
				],
				features: ['local-execute', 'credential-call-map'],
				expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
			})
		}

		if (method === 'POST' && url.pathname === '/v1/capability-proxy/call') {
			assertMockAuth(req)
			const path = Array.isArray(body?.path)
				? (body.path as Array<string>)
				: null
			const args = Array.isArray(body?.args)
				? (body.args as Array<unknown>)
				: []
			if (!path || path.length === 0) {
				return sendJson(res, 400, {
					error: { code: 'invalid_request', message: 'path is required' },
				})
			}
			const pathKey = path.join('.')
			if (!isMockCapabilityPath(pathKey)) {
				const err = notImplementedInMock({
					operation: `CapabilityProxy ${pathKey}`,
				})
				return sendJson(res, 501, { error: err.toJSON() })
			}
			try {
				const result = await dispatchCapabilityCall(pathKey, args, callCtx)
				return sendJson(res, 200, { result })
			} catch (error) {
				if (error instanceof StructuredCliError) {
					const status = error.code === 'unmocked_request' ? 400 : 501
					return sendJson(res, status, { error: error.toJSON() })
				}
				throw error
			}
		}

		if (
			method === 'POST' &&
			url.pathname === '/v1/local-execute/package-graph'
		) {
			assertMockAuth(req)
			// Empty module list: local unpublished code has no stamped kody:@ deps
			// from origin. Gateway-fetch shim is omitted; ambient secret placeholders
			// are unavailable on mock (use mock credentials instead).
			return sendJson(res, 200, {
				modules: [],
				compatibilityDate: '2026-04-16',
				compatibilityFlags: ['nodejs_compat'],
			})
		}

		// Open API style: GET /v1/search?query=
		if (method === 'GET' && url.pathname === '/v1/search') {
			assertMockAuth(req)
			const query = url.searchParams.get('query') ?? ''
			const entity = url.searchParams.get('entity') ?? undefined
			return sendJson(
				res,
				200,
				mockSearch(callCtx.getState(), { query, entity }),
			)
		}

		if (method === 'POST' && url.pathname === '/v1/search/tool') {
			assertMockAuth(req)
			const query = typeof body?.query === 'string' ? body.query : ''
			const entity = typeof body?.entity === 'string' ? body.entity : undefined
			const limit = typeof body?.limit === 'number' ? body.limit : undefined
			return sendJson(
				res,
				200,
				mockSearch(callCtx.getState(), { query, entity, limit }),
			)
		}

		if (method === 'GET' && url.pathname === '/v1/me') {
			assertMockAuth(req)
			return sendJson(
				res,
				200,
				mockCurrentUser(callCtx.getState(), callCtx.orgSlug),
			)
		}

		// Generic Open API POST /v1/... by operation is not fully routed; refuse.
		if (url.pathname.startsWith('/v1/')) {
			const err = notImplementedInMock({
				operation: `${method} ${url.pathname}`,
			})
			return sendJson(res, 501, { error: err.toJSON() })
		}

		const err = notImplementedInMock({ operation: `${method} ${url.pathname}` })
		return sendJson(res, 501, { error: err.toJSON() })
	} catch (error) {
		if (error instanceof AuthError) {
			return sendJson(res, 401, {
				error: { code: 'unauthorized', message: error.message },
			})
		}
		const message = error instanceof Error ? error.message : String(error)
		return sendJson(res, 500, {
			error: { code: 'mock_internal_error', message },
		})
	}
}

class AuthError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'AuthError'
	}
}

function assertMockAuth(req: IncomingMessage): void {
	const header = req.headers.authorization
	if (
		typeof header !== 'string' ||
		!header.toLowerCase().startsWith('bearer ')
	) {
		throw new AuthError('Mock API requires Authorization: Bearer <token>.')
	}
	const token = header.slice('bearer '.length).trim()
	if (
		!isMockApiToken(token) &&
		!token.startsWith('kody_at_') &&
		token.length > 0
	) {
		// Accept any non-empty bearer for local bridging when callers forward a
		// login token; mock still never reaches prod secrets.
		return
	}
	if (!token) throw new AuthError('Mock API bearer token is empty.')
}

async function dispatchCapabilityCall(
	pathKey: string,
	args: Array<unknown>,
	ctx: RequestCtx,
): Promise<unknown> {
	const state = ctx.getState()
	switch (pathKey) {
		case 'kody.metaGetCurrentUser':
			return mockCurrentUser(state, ctx.orgSlug)
		case 'kody.search': {
			const params = (args[0] ?? {}) as {
				query?: string
				entity?: string
				limit?: number
			}
			return mockSearch(state, params)
		}
		case 'kody.usageGet':
			return {
				period: 'mock',
				credits: { used: 0, limit: null },
				note: 'Mock usage — not real entitlement data.',
			}
		case 'kody.execute': {
			const params = (args[0] ?? {}) as { code?: string; invoke?: string }
			throw notImplementedInMock({
				operation: 'kody.execute (cloud sandbox)',
				fix: 'Use `kody execute --local --target mock` so the module runs in local workerd against this mock.',
			})
		}
		case 'kody.__mockPackageStorageGet':
		case 'kody.packageStorageGet': {
			const key = String((args[0] as { key?: string })?.key ?? '')
			return { value: packageStorageGet(state, ctx.packageId, key) ?? null }
		}
		case 'kody.__mockPackageStorageSet':
		case 'kody.packageStorageSet': {
			const input = args[0] as { key?: string; value?: unknown }
			packageStorageSet(
				state,
				ctx.packageId,
				String(input?.key ?? ''),
				input?.value,
			)
			await ctx.setState(state)
			return { ok: true }
		}
		case 'kody.__mockPackageStorageDelete':
		case 'kody.packageStorageDelete': {
			const key = String((args[0] as { key?: string })?.key ?? '')
			const deleted = packageStorageDelete(state, ctx.packageId, key)
			await ctx.setState(state)
			return { deleted }
		}
		case 'kody.__mockPackageStorageList':
		case 'kody.packageStorageList': {
			return { entries: packageStorageList(state, ctx.packageId) }
		}
		case 'kody.__mockPackageStorageSql':
		case 'kody.packageStorageSql': {
			const input = (args[0] ?? {}) as {
				query?: string
				bindings?: Array<unknown>
			}
			const query = String(input.query ?? '')
			if (!query.trim()) {
				throw new Error(
					'packageStorage().sql requires a non-empty query string.',
				)
			}
			return packageStorageSql(
				state,
				ctx.packageId,
				query,
				Array.isArray(input.bindings) ? input.bindings : [],
				ctx.env,
			)
		}
		case 'kody.credentialClientOpen': {
			const input = (args[0] ?? {}) as { key?: string; name?: string }
			const key = String(input.key ?? input.name ?? args[0] ?? '').trim()
			const opened = openMockCredential(state, key)
			return { ok: true, value: opened }
		}
		case 'kody.credentialClientOpenAll': {
			const key = String((args[0] as { key?: string })?.key ?? '').trim()
			const matches = Object.values(state.credentials).filter(
				(cred) =>
					!key ||
					cred.name === key ||
					cred.name.toUpperCase() === key.toUpperCase() ||
					cred.id === key,
			)
			if (key && matches.length === 0) {
				return { ok: true, value: [] }
			}
			const opened = (key ? matches : Object.values(state.credentials)).map(
				(cred) => mockOpenedCredential(cred),
			)
			return { ok: true, value: opened }
		}
		case 'kody.credentialClientCheck':
			return {
				ok: true,
				value: { warnings: [], checked: args[0] ?? null, strict: false },
			}
		case 'kody.credentialClientRefresh':
			return { ok: true, value: { refreshed: false, mock: true } }
		case 'kody.authenticatedFetch':
		case 'kody.gatewayFetch':
		case 'kody.gatewayFetchStream': {
			// Primary path is the Node MSW bridge (local-package-run / local-execute).
			// If a call reaches the HTTP mock, fail closed with the same paste-ready stub.
			const request = (args[0] ?? {}) as {
				request?: { url?: string; method?: string }
				url?: string
				method?: string
			}
			const nested = request.request ?? request
			const method = String(nested.method ?? 'GET').toUpperCase()
			const url = String(nested.url ?? '')
			if (url) throw unmockedRequestError(method, url)
			throw new StructuredCliError({
				code: 'unmocked_request',
				message: `Unmocked ${pathKey} under --target mock (missing request.url).`,
				target: 'mock',
				where: pathKey,
				fix: 'Pass request.url, or add handlers in .kody/mocks.ts. createAuthenticatedFetch, credential().fetch, gatewayFetch, and gatewayFetchStream go through the same MSW gateway.',
				details: { mocksPath: '.kody/mocks.ts' },
			})
		}
		case 'kody.adminUserList': {
			const params = (args[0] ?? {}) as {
				page?: number
				pageSize?: number
				limit?: number
			}
			const page = typeof params.page === 'number' ? params.page : 1
			const pageSize =
				typeof params.pageSize === 'number'
					? params.pageSize
					: typeof params.limit === 'number'
						? params.limit
						: 20
			return {
				total: 1,
				page,
				pageSize,
				users: [
					{
						stableUserId: 'user_mock',
						username: 'mock-user',
						email: 'mock@example.com',
						email_verified: true,
						email_verified_at: '2026-01-01T00:00:00.000Z',
						plan: 'free',
						manualPlan: 'free',
						stripePlan: null,
						effectivePlan: 'free',
						secondAgentGiftExpiresAt: null,
						referralCreditExpiresAt: null,
						overlayExpiresAt: null,
						isProOverlay: false,
						overlayType: null,
						entitlementLadder: 'public',
						stripeCustomerLinked: false,
						suspended_at: null,
						email_outbound_paused_at: null,
						email_verification_delivery: null,
						email_verification_delivery_detail: null,
						utm_source: null,
						utm_medium: null,
						utm_campaign: null,
						utm_content: null,
						utm_term: null,
						first_touch_landing_path: null,
						first_touch_referrer: null,
						first_mcp_connected_at: null,
						first_execute_at: null,
						first_search_at: null,
						first_saved_package_at: null,
						mcp_client_name: null,
						last_active_at: null,
						created_at: '2026-01-01T00:00:00.000Z',
						updated_at: '2026-01-01T00:00:00.000Z',
						roles: ['user'],
					},
				],
			}
		}
		default: {
			const exhaustive: never = pathKey as never
			throw notImplementedInMock({ operation: String(exhaustive) })
		}
	}
}

function openMockCredential(
	state: MockSessionState,
	key: string,
): ReturnType<typeof mockOpenedCredential> {
	const cred =
		state.credentials[key] ??
		state.credentials[key.toUpperCase()] ??
		Object.values(state.credentials).find(
			(entry) =>
				entry.name === key || entry.name.toUpperCase() === key.toUpperCase(),
		)
	if (!cred) {
		throw new StructuredCliError({
			code: 'missing_secret',
			message: `Mock credential ${JSON.stringify(key)} is not defined for this session.`,
			target: 'mock',
			fix: 'Add a fake credential to the mock session state or use --target prod with a real allow-listed secret.',
			details: { key },
		})
	}
	return mockOpenedCredential(cred)
}

function mockOpenedCredential(cred: MockSessionState['credentials'][string]) {
	return {
		handle: `mock-handle:${cred.id}`,
		key: cred.name,
		name: cred.name,
		scope: cred.scope ?? 'personal',
		kind: cred.kind,
		hosts: [...(cred.hosts?.length ? cred.hosts : ['example.com'])],
		hint: 'mock',
		// Never expose a real secret; mockValue stays session-local scratch only.
		metadata: { mock: true },
	}
}

/** Prod-shaped identity (flat user_id); honors `--org` / `?org=` on mock. */
function mockCurrentUser(state: MockSessionState, orgSlug: string) {
	return {
		user_id: 'user_mock',
		username: 'mock-user',
		email: 'mock@example.com',
		display_name: 'Mock User',
		org: {
			slug: orgSlug || 'mock-org',
		},
		mockSessionId: state.sessionId,
	}
}

function mockSearch(
	state: MockSessionState,
	params: { query?: string; entity?: string; limit?: number },
) {
	if (params.entity) {
		const hit = state.searchCatalog.find(
			(item) =>
				`${item.type}:${item.id}` === params.entity ||
				item.id === params.entity,
		)
		return {
			conversationId: `mock-${state.sessionId}`,
			matches: hit
				? [
						{
							type: hit.type,
							id: hit.id,
							entityRef: `${hit.type}:${hit.id}`,
							title: hit.title,
							description: hit.description,
						},
					]
				: [],
			offline: false,
			warnings: [],
			guidance: 'Mock catalog — not the live Kody search index.',
		}
	}
	const q = (params.query ?? '').toLowerCase().trim()
	const matches = state.searchCatalog
		.filter(
			(item) =>
				!q ||
				item.title.toLowerCase().includes(q) ||
				item.description.toLowerCase().includes(q) ||
				item.id.toLowerCase().includes(q),
		)
		.slice(0, params.limit ?? 20)
		.map((item) => ({
			type: item.type,
			id: item.id,
			entityRef: `${item.type}:${item.id}`,
			title: item.title,
			description: item.description,
		}))
	return {
		conversationId: `mock-${state.sessionId}`,
		matches,
		offline: false,
		warnings: [],
		guidance: 'Mock catalog — not the live Kody search index.',
	}
}

function mockOpenApiDocument() {
	return {
		openapi: '3.1.0',
		info: {
			title: 'Kody API (CLI mock)',
			version: 'mock',
			description:
				'Subset document for the CLI mock. Unsupported operations refuse with not_implemented_in_mock.',
		},
		paths: {
			'/v1/search': {
				get: {
					operationId: 'search',
					summary: 'Search the mock catalog',
				},
			},
			'/v1/search/tool': {
				post: {
					operationId: 'searchTool',
					summary: 'Search the mock catalog (MCP search tool shape)',
				},
			},
			'/v1/me': {
				get: {
					operationId: 'metaGetCurrentUser',
					summary: 'Mock current user',
				},
			},
		},
		'x-kody-mock-operations': [...mockOpenApiOperationIds],
	}
}

async function readJsonBody(
	req: IncomingMessage,
): Promise<Record<string, unknown> | null> {
	const chunks: Array<Buffer> = []
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	if (chunks.length === 0) return null
	const text = Buffer.concat(chunks).toString('utf8').trim()
	if (!text) return null
	try {
		return JSON.parse(text) as Record<string, unknown>
	} catch {
		return null
	}
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
	})
	res.end(payload)
}

/** Close helper used by tests and short-lived CLI commands. */
export async function withMockServer<T>(
	options: MockServerOptions,
	fn: (server: MockServer) => Promise<T>,
): Promise<T> {
	const server = await startMockServer(options)
	try {
		return await fn(server)
	} finally {
		await server.close()
	}
}

// Silence unused Server type import lint when only createServer is needed in some builds
void (null as unknown as Server)
