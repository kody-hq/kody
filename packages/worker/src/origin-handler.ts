import * as Sentry from '@sentry/cloudflare'
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { getWorkerSentryOptions } from './sentry-options.ts'
import { handleRequest } from '../start/http-entry.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	handleAuthorizeRouteException,
	handleAuthorizeInfo,
	handleOAuthProtectedApiMe,
	oauthPaths,
} from './oauth-handlers.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import {
	createSharedOAuthProviderOptions,
	mcpOAuthResourceUri,
} from '#worker/oauth-provider-options.ts'
import {
	createMcpBrowserLandingResponse,
	createMcpMissingCredentialResponse,
	handleMcpRequest,
	hasMcpBearerCredential,
	isBrowserMcpNavigation,
	mcpCorsHeadersForRequest,
	mcpResourcePath,
	protectedResourceMetadataPath,
	withMcpCors,
} from './mcp-auth.ts'
import { handleMcpClientIdMetadataRequest } from './mcp-client/client-id-metadata.ts'
import { handleCliClientIdMetadataRequest } from './cli-client-metadata.ts'
import {
	handleWebhookIngressRequest,
	isWebhookIngressRequest,
} from './webhooks/http.ts'
import {
	handlePublicPackageGitHttpRequest,
	isPublicPackageGitHttpRequest,
} from '#worker/repo/public-package-git-http.ts'
import {
	handlePlainRepoGitHttpRequest,
	isPlainRepoGitHttpRequest,
} from '#worker/repo/plain-repo-git-http.ts'
import { withCors } from './utils.ts'
import { normalizeRedirectTo } from '#app/auth-redirect.ts'
import { checkAuthRateLimit } from '#app/rate-limit.ts'
import { getRequestIp } from '#worker/audit-log.ts'
import { discardUnreadRequestBody } from '#worker/request-body.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { handleCapabilityReindexRequest } from './capability-maintenance.ts'
import { handleExecuteSmokeRequest } from './execute-maintenance.ts'
import {
	executeHealthMaintenancePath,
	handleExecuteHealthProbeRequest,
} from './execute-health-probe.ts'
import { handleJobReindexRequest } from './job-maintenance.ts'
import { handleMemoryReindexRequest } from './memory-maintenance.ts'
import {
	handlePackageAppRequest,
	isPackageAppRequestPath,
} from '#app/handlers/package-app.ts'
import {
	handlePackageAppOriginRequest,
	resolveVerifiedCustomHostnameIfEnabled,
} from '#app/package-app-origin.ts'
import { refuseNonCanonicalProductionHost } from '#app/canonical-host.ts'
import { deliverAnonymousDocument } from '#app/anonymous-html-edge-cache.ts'
import { handleInboundEmail } from '#worker/email/inbound.ts'
import { handleQueueBatch } from '#worker/queue-handler.ts'
import { handleDrRestoreRequest } from '#worker/dr/dr-restore.ts'
import { handleDrExportRequest } from '#worker/dr/dr-export-maintenance.ts'
import { handleDoPitrRequest } from '#worker/dr/do-pitr-maintenance.ts'
import { handleMailboxImportRequest } from '#worker/dr/mailbox-import-maintenance.ts'
import { handleStatusIncidentEventRequest } from '#worker/status-incidents/maintenance.ts'
import { verifyPublicFormProtection } from '#app/public-form-protection.ts'
import { getLegacyHostRedirectResponse } from '#worker/app-legacy-redirect.ts'
import { isRuntimeWorkerOwnedRequest } from '#worker/runtime-worker-routing.ts'
import {
	forwardRuntimeWorkerFetch,
	stripPackageAppRuntimeRunId,
} from '#worker/package-runtime/package-app-diagnostics.ts'
import {
	isNamespacedAppEndpointPath,
	retiredConnectorsPathPrefix,
} from '#worker/user-namespace-routes.ts'
import { requestSkipsAssetProbe } from './static-asset-probe.ts'
import { handleOpenIdConfigurationRequest } from '#worker/oidc/discovery.ts'
import { handleOidcJwksRequest } from '#worker/oidc/jwks.ts'
import { handleOidcUserinfoRequest } from '#worker/oidc/userinfo.ts'
import { handleOidcLogoutRequest } from '#worker/oidc/logout.ts'
import { enrichOAuthTokenResponse } from '#worker/oidc/token-enrichment.ts'
import { handleMcpOAuthTokenRequest } from '#worker/oauth-refresh-family.ts'
import { runWithDynamicWorkerEvaluationBudget } from '#worker/dynamic-worker-evaluation-budget.ts'

// Immutable caching is only safe when asset URLs are versioned by a real
// commit sha. In local dev the build id falls back to a constant ('dev'), so
// an immutable header would pin browsers to a stale bundle across rebuilds.
type LegacyMcpFetch = Parameters<typeof handleMcpRequest>[0]['fetchMcp']
let legacyMcpFetchMemo: Promise<LegacyMcpFetch> | null = null

/**
 * The legacy MCP lane routes through the `MCP` Durable Object stub via the
 * agents SDK. Loading `./mcp/index.ts` statically would evaluate the agents
 * and MCP server SDKs during Worker startup; the first legacy request pays
 * for it instead and the served fetch is cached for the isolate.
 */
function loadLegacyMcpFetch(): Promise<LegacyMcpFetch> {
	legacyMcpFetchMemo ??= import('./mcp/index.ts')
		.then(
			({ MCP }) =>
				MCP.serve(mcpResourcePath, { binding: 'MCP_OBJECT' })
					.fetch as LegacyMcpFetch,
		)
		.catch((error: unknown) => {
			legacyMcpFetchMemo = null
			throw error
		})
	return legacyMcpFetchMemo
}

function shouldApplyLongLivedAssetCaching(pathname: string, env: Env) {
	const commitSha = (env as { APP_COMMIT_SHA?: string }).APP_COMMIT_SHA?.trim()
	if (!commitSha) return false
	return (
		pathname === '/client-entry.js' ||
		pathname === '/styles.css' ||
		pathname.startsWith('/assets/')
	)
}

// Credential-accepting POST endpoints share one per-IP auth rate-limit bucket
// so brute-force attempts cannot fan out across parallel paths (password login,
// OAuth inline login, social-login starts, password-reset request/confirm,
// two-factor code verification and management, and passkey sign-in).
const socialLoginStartPaths = new Set([
	'/auth/github',
	'/auth/google',
	'/auth/x',
	'/auth/discord',
])

const rateLimitedAuthPaths = new Set([
	'/auth',
	...socialLoginStartPaths,
	'/oauth/authorize',
	packageAppOauthPaths.authorize,
	'/webauthn/authentication',
])

const protectedPublicJsonFormPaths = new Set(['/webauthn/authentication'])

const appHandler = withCors({
	getCorsHeaders(request): Record<string, string> | null {
		const url = new URL(request.url)
		const origin = request.headers.get('Origin')
		if (!origin) return null
		const requestOrigin = url.origin
		// Remote MCP clients in browser hosts (Gemini custom apps, etc.) call
		// `/mcp` cross-origin. Reflect any Origin and expose WWW-Authenticate so
		// the client can read the OAuth challenge; same-origin stays the default
		// for the rest of the app. Authenticated `/mcp` traffic goes through
		// OAuthProvider's apiHandler (library CORS); this covers defaultHandler
		// fallthrough and other same-origin paths that still hit appHandler.
		if (
			url.pathname === mcpResourcePath ||
			url.pathname === `${mcpResourcePath}/`
		) {
			return mcpCorsHeadersForRequest(request)
		}
		if (origin !== requestOrigin) return null
		return {
			'Access-Control-Allow-Origin': origin,
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'content-type, authorization',
			Vary: 'Origin',
		}
	},
	async handler(request, env, ctx) {
		const url = new URL(request.url)

		if (request.method === 'POST' && rateLimitedAuthPaths.has(url.pathname)) {
			const ip = getRequestIp(request) ?? 'unknown'
			const rateLimitKey = `auth:ip:${ip}`
			const result = await checkAuthRateLimit(env, rateLimitKey)
			if (!result.allowed) {
				// A non-JSON social-login start is a document navigation, so a
				// JSON 429 body would render as raw text; bounce back to the
				// login page instead. 303 forces a GET. (The first-party UI
				// sends Accept: application/json and gets the JSON 429.)
				const prefersJson = request.headers
					.get('Accept')
					?.toLowerCase()
					.includes('application/json')
				if (socialLoginStartPaths.has(url.pathname) && !prefersJson) {
					const loginUrl = new URL('/login', url)
					loginUrl.searchParams.set('oauthError', 'rate-limited')
					const redirectTo = normalizeRedirectTo(
						url.searchParams.get('redirectTo'),
					)
					if (redirectTo) {
						loginUrl.searchParams.set('redirectTo', redirectTo)
					}
					return new Response(null, {
						status: 303,
						headers: {
							Location: loginUrl.toString(),
							'Retry-After': String(result.retryAfterSeconds ?? 60),
						},
					})
				}
				return new Response(
					JSON.stringify({
						error: 'Too many requests. Please try again later.',
					}),
					{
						status: 429,
						headers: {
							'Content-Type': 'application/json',
							'Retry-After': String(result.retryAfterSeconds ?? 60),
						},
					},
				)
			}
		}

		if (
			request.method === 'POST' &&
			protectedPublicJsonFormPaths.has(url.pathname)
		) {
			const body = (await request
				.clone()
				.json()
				.catch(() => ({}))) as Record<string, unknown>
			const protection = await verifyPublicFormProtection({
				env,
				request,
				body: typeof body === 'object' && body !== null ? body : {},
			})
			if (!protection.ok) {
				// The clone was the only branch we read. Drain the original
				// before returning so workerd does not keep a teed body
				// alive (isolate kill → wrangler ProxyWorker fatal exit).
				await discardUnreadRequestBody(request)
				return protection.response
			}
		}

		if (url.pathname === '/__maintenance/reindex-capabilities') {
			return handleCapabilityReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/execute-smoke') {
			// Origin-only: proves this script's ctx.exports.KodyFetchGateway.
			// MCP execute looks up the gateway on kody-platform.
			return handleExecuteSmokeRequest(request, env)
		}

		if (url.pathname === executeHealthMaintenancePath) {
			return handleExecuteHealthProbeRequest(
				request,
				env,
				ctx,
				(mcpRequest, mcpEnv, mcpContext) =>
					loadLegacyMcpFetch().then((fetchLegacy) =>
						fetchLegacy(mcpRequest, mcpEnv, mcpContext),
					),
			)
		}

		if (url.pathname === '/__maintenance/reindex-memories') {
			return handleMemoryReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/reindex-jobs') {
			return handleJobReindexRequest(request, env)
		}

		if (url.pathname === '/__maintenance/dr-restore') {
			return handleDrRestoreRequest(request, env)
		}

		if (url.pathname === '/__maintenance/dr-export') {
			return handleDrExportRequest(request, env)
		}

		if (url.pathname === '/__maintenance/do-pitr') {
			return handleDoPitrRequest(request, env)
		}

		if (url.pathname === '/__maintenance/dr-mailbox-import') {
			return handleMailboxImportRequest(request, env)
		}

		if (url.pathname === '/__maintenance/status-incidents') {
			return handleStatusIncidentEventRequest(request, env, ctx)
		}

		if (url.pathname.startsWith('/__maintenance/')) {
			return Response.json(
				{ error: 'Unknown maintenance endpoint.' },
				{ status: 404 },
			)
		}

		if (url.pathname === oauthPaths.authorizeInfo) {
			try {
				return await handleAuthorizeInfo(request, env)
			} catch (error) {
				Sentry.captureException(error)
				return handleAuthorizeRouteException(request)
			}
		}

		if (url.pathname === '/.well-known/appspecific/com.chrome.devtools.json') {
			return new Response(null, { status: 204 })
		}

		// Trailing-slash variants 404 otherwise; some MCP client docs (and paste
		// habits) include the slash. Keep the protected resource at `/mcp`.
		// Authenticated `/mcp` is owned by OAuthProvider's apiHandler; this is
		// fallthrough only.
		if (url.pathname === `${mcpResourcePath}/`) {
			const canonical = new URL(request.url)
			canonical.pathname = mcpResourcePath
			return Response.redirect(canonical.toString(), 308)
		}

		if (url.pathname === '/api/me') {
			return handleOAuthProtectedApiMe(request, env)
		}

		// Non-production inline package apps. Production requests normally redirect
		// in handlePackageAppOriginRequest; this handler independently returns 500
		// rather than executing package code if that routing invariant is broken.
		if (isPackageAppRequestPath(url.pathname)) {
			const response = await handlePackageAppRequest(request, env)
			return stripPackageAppRuntimeRunId(response).response
		}

		if (isNamespacedAppEndpointPath(url.pathname)) {
			return new Response('Not Found', { status: 404 })
		}

		if (url.pathname.startsWith(`${retiredConnectorsPathPrefix}/`)) {
			return new Response('Not Found', { status: 404 })
		}

		// Try to serve static assets for safe methods only. Any non-404 status
		// (including 304 Not Modified for conditional requests) must be passed
		// through; treating 304 as a miss would fall through to the app router
		// and return 404 for every browser revalidation request.
		// Dynamic prefixes owned by the route table (and pre-router mounts such
		// as /mcp) never have a public/ twin, so skip the probe on those GETs.
		if (
			env.ASSETS &&
			(request.method === 'GET' || request.method === 'HEAD') &&
			!requestSkipsAssetProbe(url.pathname)
		) {
			const response = await env.ASSETS.fetch(request)
			if (response.status !== 404) {
				if (shouldApplyLongLivedAssetCaching(url.pathname, env)) {
					const headers = new Headers(response.headers)
					headers.set('Cache-Control', 'public, max-age=31536000, immutable')
					return new Response(response.body, {
						status: response.status,
						statusText: response.statusText,
						headers,
					})
				}
				return response
			}
		}

		return handleRequest(request, env, ctx)
	},
})

// Endpoints, scopes, TTLs, CIMD, resource, and onError live in
// `#worker/oauth-provider-options.ts` so the handler-less `getOAuthApi`
// fallback (`#worker/oauth-helpers.ts`) is configured identically.
// v1 pins `resourceMetadata.resource` per origin (preview/local/production),
// so providers are created lazily and cached by resource URI.
const oauthProvidersByResource = new Map<string, OAuthProvider>()

const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handleMcpRequest({
			request,
			env,
			ctx,
			fetchMcp: (mcpRequest, mcpEnv, mcpContext) =>
				loadLegacyMcpFetch().then((fetchLegacy) =>
					fetchLegacy(mcpRequest, mcpEnv, mcpContext),
				),
		})
	},
} satisfies ExportedHandler<Env>

function isLoopbackHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		/^127(?:\.\d{1,3}){3}$/.test(hostname) ||
		hostname === '[::1]' ||
		hostname === '::1'
	)
}

/**
 * Returns a 308 redirect to the HTTPS equivalent of `url` when the resolved
 * app origin is plain `http:` on a non-loopback host; otherwise `null`.
 * Loopback hosts stay on HTTP for local development.
 */
function getInsecureOriginRedirect(appOrigin: string, url: URL) {
	const origin = new URL(appOrigin)
	if (origin.protocol !== 'http:' || isLoopbackHostname(origin.hostname)) {
		return null
	}
	const secureUrl = new URL(url)
	secureUrl.protocol = 'https:'
	// An explicit HTTP port does not imply a TLS listener on the same port;
	// target the default HTTPS port (443) instead.
	secureUrl.port = ''
	return Response.redirect(secureUrl.toString(), 308)
}

function getOriginOAuthProvider(resource: string) {
	const existing = oauthProvidersByResource.get(resource)
	if (existing) return existing
	const provider = new OAuthProvider({
		...createSharedOAuthProviderOptions(resource),
		apiHandler: mcpApiHandler,
		defaultHandler: {
			fetch(request, env, ctx) {
				return appHandler(request, env, ctx)
			},
		},
	})
	oauthProvidersByResource.set(resource, provider)
	return provider
}

/**
 * Aligns with @cloudflare/workers-oauth-provider's addCorsHeaders for well-known routes.
 * (See OAuthProviderImpl.fetch in that package.)
 */
function addOAuthDiscoveryCorsHeaders(
	response: Response,
	request: Request,
): Response {
	const origin = request.headers.get('Origin')
	if (!origin) {
		return response
	}
	const headers = new Headers(response.headers)
	headers.set('Access-Control-Allow-Origin', origin)
	const vary = headers.get('Vary')
	headers.set('Vary', vary ? `${vary}, Origin` : 'Origin')
	headers.set('Access-Control-Allow-Methods', '*')
	headers.set('Access-Control-Allow-Headers', 'Authorization, *')
	headers.set('Access-Control-Max-Age', '86400')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

function isMcpResourceOwnedPath(pathname: string) {
	return (
		pathname === mcpResourcePath || pathname.startsWith(`${mcpResourcePath}/`)
	)
}

function isOAuthProviderOwnedPath(pathname: string) {
	return (
		pathname === oauthPaths.token ||
		pathname === oauthPaths.register ||
		pathname === oauthPaths.discovery ||
		pathname === protectedResourceMetadataPath ||
		pathname.startsWith(`${protectedResourceMetadataPath}/`) ||
		isMcpResourceOwnedPath(pathname)
	)
}

function isMalformedOAuthClientException(error: unknown, pathname: string) {
	const message = error instanceof Error ? error.message : ''
	// @cloudflare/workers-oauth-provider still throws this raw TypeError when a
	// stored client is missing redirectUris during token redirect_uri checks.
	return (
		pathname === oauthPaths.token &&
		message.includes("Cannot read properties of undefined (reading 'some')")
	)
}

/**
 * Catchable throws on `/mcp` must stay on the connection as JSON-RPC so MCP
 * clients treat the call as a failed request instead of an OAuth token error
 * (or a Cloudflare 1101 if the error is rethrown). Real OAuth routes keep the
 * RFC 6749 error object. This does not cover isolate kills.
 *
 * Request IDs are peeked from a clone before `oauthProvider.fetch` so the error
 * can correlate with the pending call. Peeking is capped so large execute
 * bodies are not doubled in memory (memory-limit faults are out of scope).
 * When a clone was created, the catch path discards the original body so an
 * unread tee cannot terminate the isolate.
 */
const mcpJsonRpcIdPeekLimitBytes = 64_000
const mcpJsonRpcIdPeekDeadlineMs = 250

type McpJsonRpcPeek =
	| { kind: 'unknown' }
	| { kind: 'notifications' }
	| { kind: 'requests'; ids: Array<string | number>; batch: boolean }

type McpJsonRpcPeekResult = {
	peek: McpJsonRpcPeek
	/** True when `request.clone()` ran (a tee exists that may need draining). */
	cloned: boolean
}

function isJsonRpcId(value: unknown): value is string | number {
	return typeof value === 'string' || typeof value === 'number'
}

function isValidJsonRpcMessage(message: Record<string, unknown>) {
	if (message['jsonrpc'] !== '2.0') return false
	if (typeof message['method'] !== 'string') return false
	if ('id' in message && !isJsonRpcId(message['id'])) return false
	return true
}

/**
 * Read at most `maxBytes` from a request body within `deadlineMs`. Returns
 * `null` when the body exceeds the cap, the deadline expires, or the stream
 * cannot be read — callers then skip JSON-RPC id peeking.
 */
async function readRequestTextUpTo(
	request: {
		body: ReadableStream<Uint8Array> | null
		text(): Promise<string>
	},
	maxBytes: number,
	deadlineMs: number,
): Promise<string | null> {
	const body = request.body
	if (!body) {
		const text = await Promise.race([
			request.text(),
			new Promise<null>((resolve) => {
				setTimeout(() => resolve(null), deadlineMs)
			}),
		])
		if (text === null) return null
		return text.length > maxBytes ? null : text
	}
	const reader = body.getReader()
	const chunks: Array<Uint8Array> = []
	let total = 0
	let timedOut = false
	const timeoutId = setTimeout(() => {
		timedOut = true
		void reader.cancel()
	}, deadlineMs)
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (timedOut) return null
			if (done) break
			if (!value) continue
			total += value.byteLength
			if (total > maxBytes) {
				// Do not await cancel: tee-branch cancellation can stay pending
				// until the sibling branch is consumed, which would stall
				// oauthProvider.fetch on the original request.
				void reader.cancel()
				return null
			}
			chunks.push(value)
		}
	} catch {
		if (timedOut) return null
		throw new Error('MCP JSON-RPC id peek body read failed')
	} finally {
		clearTimeout(timeoutId)
		try {
			reader.releaseLock()
		} catch {
			// Already canceled/released after deadline or over-limit cancel.
		}
	}
	const merged = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		merged.set(chunk, offset)
		offset += chunk.byteLength
	}
	return new TextDecoder().decode(merged)
}

function classifyParsedMcpJsonRpcBody(parsed: unknown): McpJsonRpcPeek {
	if (Array.isArray(parsed)) {
		if (parsed.length === 0) return { kind: 'unknown' }
		const messages = parsed.filter(isRecord)
		if (messages.length !== parsed.length) return { kind: 'unknown' }
		if (!messages.every(isValidJsonRpcMessage)) return { kind: 'unknown' }
		const ids = messages
			.filter((message) => 'id' in message)
			.map((message) => message['id'] as string | number)
		if (ids.length === 0) return { kind: 'notifications' }
		return { kind: 'requests', ids, batch: true }
	}
	if (!isRecord(parsed) || !isValidJsonRpcMessage(parsed)) {
		return { kind: 'unknown' }
	}
	if (!('id' in parsed)) return { kind: 'notifications' }
	return {
		kind: 'requests',
		ids: [parsed['id'] as string | number],
		batch: false,
	}
}

async function peekMcpJsonRpcRequestIds(
	request: Request,
): Promise<McpJsonRpcPeekResult> {
	const contentLengthHeader = request.headers.get('Content-Length')
	if (contentLengthHeader !== null) {
		const contentLength = Number(contentLengthHeader)
		if (
			!Number.isFinite(contentLength) ||
			contentLength <= 0 ||
			contentLength > mcpJsonRpcIdPeekLimitBytes
		) {
			return { peek: { kind: 'unknown' }, cloned: false }
		}
	}
	try {
		const text = await readRequestTextUpTo(
			request.clone(),
			mcpJsonRpcIdPeekLimitBytes,
			mcpJsonRpcIdPeekDeadlineMs,
		)
		if (text === null || text === '') {
			return { peek: { kind: 'unknown' }, cloned: true }
		}
		return {
			peek: classifyParsedMcpJsonRpcBody(JSON.parse(text)),
			cloned: true,
		}
	} catch {
		return { peek: { kind: 'unknown' }, cloned: true }
	}
}

function createMcpJsonRpcInternalError(id: string | number | null) {
	return {
		jsonrpc: '2.0' as const,
		id,
		error: {
			code: -32603,
			message: 'Internal error',
		},
	}
}

function createMcpProviderExceptionResponse(
	request: Request,
	peek: McpJsonRpcPeek,
) {
	const headers = {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json',
	}
	switch (peek.kind) {
		case 'unknown':
			return withMcpCors(
				request,
				new Response(JSON.stringify(createMcpJsonRpcInternalError(null)), {
					status: 500,
					headers,
				}),
			)
		case 'notifications':
			// Notifications have a method but no id — JSON-RPC forbids a response body.
			return withMcpCors(
				request,
				new Response(null, {
					status: 500,
					headers: { 'Cache-Control': 'no-store' },
				}),
			)
		case 'requests': {
			const body = peek.batch
				? peek.ids.map((id) => createMcpJsonRpcInternalError(id))
				: createMcpJsonRpcInternalError(peek.ids[0]!)
			return withMcpCors(
				request,
				new Response(JSON.stringify(body), {
					status: 500,
					headers,
				}),
			)
		}
		default: {
			const exhaustive: never = peek
			throw new Error(
				`unexpected MCP JSON-RPC peek kind: ${JSON.stringify(exhaustive)}`,
			)
		}
	}
}

function createOAuthProviderExceptionResponse(
	error: unknown,
	pathname: string,
) {
	const headers = {
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json',
	}
	if (isMalformedOAuthClientException(error, pathname)) {
		return new Response(
			JSON.stringify({
				error: 'invalid_client',
				error_description: 'Invalid OAuth client registration.',
			}),
			{ status: 401, headers },
		)
	}

	const errorDescription =
		pathname === oauthPaths.register
			? 'Invalid OAuth client registration.'
			: 'OAuth provider request failed.'
	return new Response(
		JSON.stringify({
			error:
				pathname === oauthPaths.register ? 'invalid_request' : 'server_error',
			error_description: errorDescription,
		}),
		{ status: pathname === oauthPaths.register ? 400 : 500, headers },
	)
}

function createProviderOwnedPathExceptionResponse(
	error: unknown,
	pathname: string,
	request: Request,
	mcpPeek: McpJsonRpcPeek,
) {
	if (isMcpResourceOwnedPath(pathname)) {
		return createMcpProviderExceptionResponse(request, mcpPeek)
	}
	return createOAuthProviderExceptionResponse(error, pathname)
}

const workerHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return runWithDynamicWorkerEvaluationBudget(
			async () => await fetchWithDynamicWorkerBudget(request, env, ctx),
		)
	},
	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	) {
		await runWithDynamicWorkerEvaluationBudget(async () => {
			// Let storage/transient failures throw so Email Routing does not
			// acknowledge the message (retryable). Permanent rejects use
			// message.setReject inside handleInboundEmail.
			await handleInboundEmail(message, env, ctx)
		})
	},
	async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext) {
		await runWithDynamicWorkerEvaluationBudget(
			async () => await handleQueueBatch(batch, env, ctx),
		)
	},
} satisfies ExportedHandler<Env>

async function fetchWithDynamicWorkerBudget(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
) {
	const url = new URL(request.url)

	// Production `*.workers.dev` is not a product origin. `/health` stays
	// reachable so deploy and status probes can hit the script directly.
	const nonCanonicalHost = refuseNonCanonicalProductionHost({
		request,
		env,
		allowedHealthPath: '/health',
	})
	if (nonCanonicalHost) {
		// Workers tests and any custom hostname that reaches this script
		// (instead of the runtime Worker) still need the verified mapping.
		const customHostname = await resolveVerifiedCustomHostnameIfEnabled(
			request,
			env,
		)
		if (!customHostname) return nonCanonicalHost
		// Custom hosts are not in the sync runtime-ownership predicate (D1).
		// When the binding exists, forward wholesale so handoff HMAC and
		// package serve stay on kody-runtime.
		if (env.RUNTIME_WORKER) {
			return forwardRuntimeWorkerFetch(env.RUNTIME_WORKER, request)
		}
	}

	// Package runtime lane extraction (ADR 0016): when the runtime Worker
	// service binding is configured, runtime-owned requests (package-app
	// origin, inline package apps, package invocation API) are forwarded
	// wholesale to the `kody-runtime` Worker. Without the binding (tests,
	// single-worker local dev) the in-process handlers below keep serving.
	if (env.RUNTIME_WORKER && isRuntimeWorkerOwnedRequest(request, env)) {
		// Sentry instruments Fetcher.fetch and rebuilds Requests, dropping the
		// forbidden Upgrade header. Preserve WebSocket upgrades explicitly.
		return forwardRuntimeWorkerFetch(env.RUNTIME_WORKER, request)
	}

	// Host isolation for hosted package apps before first-party surfaces,
	// including the public `.git` proxy (which must also stay ahead of the
	// anonymous HTML edge cache).
	const packageAppOriginResponse = await handlePackageAppOriginRequest(
		request,
		env,
		ctx,
	)
	if (packageAppOriginResponse) return packageAppOriginResponse

	// Public package `.git` smart HTTP must run before the anonymous HTML edge
	// cache: `/@owner/pkg.git` can otherwise match the community package route
	// matcher as a visibility-gated HTML path.
	if (isPublicPackageGitHttpRequest(url.pathname)) {
		const gitResponse = await handlePublicPackageGitHttpRequest(
			request,
			env,
			(promise) => ctx.waitUntil(promise),
		)
		if (gitResponse) return gitResponse
	}

	// Plain-repo Artifacts git proxy (repoGetGitRemote remotes). Waits out
	// receive-pack lock contention (bounded) before 503 + Retry-After.
	if (isPlainRepoGitHttpRequest(url.pathname)) {
		const gitResponse = await handlePlainRepoGitHttpRequest(request, env)
		if (gitResponse) return gitResponse
	}

	return deliverAnonymousDocument(
		request,
		await handleOriginAppFetch(request, env, ctx, url),
	)
}

async function handleOriginAppFetch(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	url: URL,
) {
	// Host isolation for hosted package apps runs before every other route:
	// nothing first-party may be reachable on the package-app origin, and the
	// app origin must not execute package code once that origin is configured.
	const packageAppOriginResponse = await handlePackageAppOriginRequest(
		request,
		env,
		ctx,
	)
	if (packageAppOriginResponse) return packageAppOriginResponse

	if (isWebhookIngressRequest(url.pathname)) {
		return handleWebhookIngressRequest(request, env, ctx)
	}

	// Domain-migration redirect for safe browser navigation from legacy app
	// hosts. Runs after the API-shaped surfaces (package apps, webhooks) so
	// those keep serving on every attached host, and skips MCP/OAuth/auth/
	// health paths itself. No-op unless APP_LEGACY_REDIRECT is enabled.
	const legacyHostRedirect = getLegacyHostRedirectResponse({ request, env })
	if (legacyHostRedirect) return legacyHostRedirect

	// OAuthProvider serves this URL first and defaults `resource` to the origin only.
	// MCP clients must use `<origin>/mcp` as the resource (RFC 8707) to match our
	// token audience; otherwise authorize stores origin but the token request sends
	// `/mcp` → invalid_target. Serve the same document as the `/mcp` metadata path.
	const clientIdMetadataResponse =
		handleMcpClientIdMetadataRequest(request) ??
		handleCliClientIdMetadataRequest(request)
	if (clientIdMetadataResponse) {
		return addOAuthDiscoveryCorsHeaders(clientIdMetadataResponse, request)
	}

	if (url.pathname === oauthPaths.openidConfiguration) {
		if (request.method === 'OPTIONS') {
			return addOAuthDiscoveryCorsHeaders(
				new Response(null, {
					status: 204,
					headers: { 'Content-Length': '0' },
				}),
				request,
			)
		}
		return addOAuthDiscoveryCorsHeaders(
			handleOpenIdConfigurationRequest(request, env),
			request,
		)
	}

	if (url.pathname === oauthPaths.jwks) {
		if (request.method === 'OPTIONS') {
			return addOAuthDiscoveryCorsHeaders(
				new Response(null, {
					status: 204,
					headers: { 'Content-Length': '0' },
				}),
				request,
			)
		}
		return addOAuthDiscoveryCorsHeaders(
			await handleOidcJwksRequest(request, env),
			request,
		)
	}

	if (url.pathname === oauthPaths.userinfo) {
		return handleOidcUserinfoRequest(request, env)
	}

	if (url.pathname === oauthPaths.logout) {
		return handleOidcLogoutRequest(request, env)
	}

	// RFC 9728 PRM for `/mcp` is served by OAuthProvider once
	// `resourceMetadata.resource` is set (path-aware URL only:
	// `/.well-known/oauth-protected-resource/mcp`). Do not serve a second
	// custom document here — it would diverge from the library's audience.

	// OAuthProvider v1 rejects a non-loopback `http:` resource URI, and the
	// resource is derived from the request origin. Upgrade plain-HTTP requests
	// (crawlers hitting `http://kody.codes/...`) to HTTPS instead of throwing.
	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	const insecureRedirect = getInsecureOriginRedirect(appOrigin, url)
	if (insecureRedirect) return insecureRedirect

	const resource = mcpOAuthResourceUri(appOrigin)
	const oauthProvider = getOriginOAuthProvider(resource)

	// Gemini (and other browser MCP hosts) treat an empty-bodied 401 as a hard
	// failure. The library's missing-bearer challenge has no JSON body, so
	// short-circuit that case with Kody's JSON challenge before OAuthProvider.
	// Browser HTML navigations to `/mcp` get a landing page instead of 401.
	if (url.pathname === `${mcpResourcePath}/`) {
		const canonical = new URL(request.url)
		canonical.pathname = mcpResourcePath
		return Response.redirect(canonical.toString(), 308)
	}
	if (url.pathname === mcpResourcePath) {
		if (request.method === 'OPTIONS') {
			return withMcpCors(
				request,
				new Response(null, {
					status: 204,
					headers: { 'Content-Length': '0' },
				}),
			)
		}
		if (isBrowserMcpNavigation(request)) {
			return createMcpBrowserLandingResponse(request)
		}
		if (!hasMcpBearerCredential(request)) {
			return withMcpCors(
				request,
				createMcpMissingCredentialResponse(
					getAppBaseUrl({ env, requestUrl: request.url }),
				),
			)
		}
	}

	let mcpPeek: McpJsonRpcPeek = { kind: 'unknown' }
	let mcpPeekCloned = false
	try {
		if (url.pathname === oauthPaths.token && request.method === 'POST') {
			const { response, grantType } = await handleMcpOAuthTokenRequest({
				request,
				env,
				fetchProvider: (providerRequest) =>
					oauthProvider.fetch(providerRequest, env, ctx),
			})
			return enrichOAuthTokenResponse(request, response, env, {
				grantType,
			})
		}
		if (isMcpResourceOwnedPath(url.pathname) && request.method === 'POST') {
			const peeked = await peekMcpJsonRpcRequestIds(request)
			mcpPeek = peeked.peek
			mcpPeekCloned = peeked.cloned
		}
		return await oauthProvider.fetch(request, env, ctx)
	} catch (error) {
		if (!isOAuthProviderOwnedPath(url.pathname)) throw error
		Sentry.captureException(error)
		if (mcpPeekCloned) {
			// Only discard when a clone tee exists. Skipping avoids buffering a
			// large body that was never cloned (Content-Length over the peek
			// limit). When cloned, drain the original so workerd does not kill
			// the isolate for an unread tee branch.
			await discardUnreadRequestBody(request)
		}
		return createProviderOwnedPathExceptionResponse(
			error,
			url.pathname,
			request,
			mcpPeek,
		)
	}
}

export const originWorkerHandler = Sentry.withSentry(
	(env: Env) => getWorkerSentryOptions(env),
	workerHandler,
)
