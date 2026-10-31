import { personalOrgId } from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	insufficientScope,
	type OAuthHelpers,
	type OAuthResourceAuth,
	type TokenSummary,
} from '@cloudflare/workers-oauth-provider'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { auditDatabaseFromEnv, getRequestIp } from '#worker/audit-log.ts'
import { buildMcpAuthContextCached } from './mcp-auth-user-context.ts'
import { evictMcpAuthCache } from '#worker/mcp-auth-cache.ts'
import {
	type McpAuthDenialReason,
	recordMcpAuthDenial,
} from './mcp/auth-audit.ts'
import {
	AccountDeletionInProgressError,
	AccountWriteLeaseLostError,
	assertAccountWritableDb,
	withAccountWriteLease,
} from '#worker/account/deletion-state.ts'
import {
	createMcpCallerContext,
	toMcpCallerContextWire,
	type McpServerProps,
} from './mcp/context.ts'
import type * as StatelessLane from './mcp/stateless-lane.ts'
import {
	classifyMcpProtocolRequest,
	recordMcpProtocolEvent,
} from './mcp/protocol-metrics.ts'
import {
	extractJsonRpcRequestIds,
	guardLegacyLaneSseResponse,
} from './mcp/sse-response-guard.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import { mcpOAuthResourceUri } from '#worker/oauth-provider-options.ts'
import { stampFirstMcpConnected } from '#worker/identity/activation-stamps.ts'
import { recordInboundMcpConnectionLastUsed } from '#worker/inbound-mcp-connection-last-used.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import { grantHasRetiredConnectionProfile } from '#worker/orgs/oauth-grant.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const mcpResourcePath = '/mcp'
export const protectedResourceMetadataPath =
	'/.well-known/oauth-protected-resource'

type OAuthEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpers
}

type OAuthContextProps = McpServerProps & {
	user?: TokenSummary['grant']['props'] | null
}

type OAuthExecutionContext = ExecutionContext & {
	props?: OAuthContextProps
	auth?: OAuthResourceAuth
}

/**
 * RFC 9728 path-aware PRM URL for `<origin>/mcp`
 * (`/.well-known/oauth-protected-resource/mcp`). v1 of the OAuth provider
 * serves only this document; the root well-known path is not an alias.
 */
export function mcpProtectedResourceMetadataUrl(origin: string) {
	return `${origin}${protectedResourceMetadataPath}${mcpResourcePath}`
}

/**
 * Expected PRM document shape for `<origin>/mcp`. Kept for tests and agent
 * discovery copy; the live document is served by
 * `@cloudflare/workers-oauth-provider` once `resourceMetadata.resource` is set.
 * Do not serve a second copy from app code.
 */
export function buildProtectedResourceMetadata(origin: string) {
	return {
		resource: mcpOAuthResourceUri(origin),
		authorization_servers: [origin],
		scopes_supported: mcpOauthScopes,
		bearer_methods_supported: ['header'],
	}
}

export function isProtectedResourceMetadataRequest(pathname: string) {
	return pathname === `${protectedResourceMetadataPath}${mcpResourcePath}`
}

export const mcpInvalidTokenDescription =
	'Authentication required. Obtain an access token via OAuth and retry with Authorization: Bearer.'

type McpUnauthorizedKind = 'missing_credential' | 'invalid_token'

function buildWwwAuthenticateHeader(origin: string, kind: McpUnauthorizedKind) {
	const resourceMetadata = mcpProtectedResourceMetadataUrl(origin)
	const scope =
		mcpOauthScopes.length > 0 ? `, scope="${mcpOauthScopes.join(' ')}"` : ''
	const resourceAndScope = `resource_metadata="${resourceMetadata}"${scope}`
	switch (kind) {
		case 'missing_credential':
			// RFC 6750 §3.1: omit error attributes when no credentials were sent.
			return `Bearer ${resourceAndScope}`
		case 'invalid_token':
			// Hosts that refresh on `error="invalid_token"` need that attribute on
			// the wire, not only in the JSON body.
			return `Bearer error="invalid_token", error_description="${mcpInvalidTokenDescription}", ${resourceAndScope}`
		default: {
			const exhaustive: never = kind
			throw new Error(`unexpected MCP unauthorized kind: ${exhaustive}`)
		}
	}
}

function createUnauthorizedBody(kind: McpUnauthorizedKind) {
	switch (kind) {
		case 'missing_credential':
			return { error_description: mcpInvalidTokenDescription }
		case 'invalid_token':
			return {
				error: 'invalid_token',
				error_description: mcpInvalidTokenDescription,
			}
		default: {
			const exhaustive: never = kind
			throw new Error(`unexpected MCP unauthorized kind: ${exhaustive}`)
		}
	}
}

function readBearerToken(authorization: string | null) {
	if (!authorization) return null
	const match = authorization.match(/^Bearer(?:\s+(.*))?$/i)
	if (!match) return null
	const token = match[1]?.trim() ?? ''
	return token.length > 0 ? token : null
}

/** True when Authorization carries a non-empty Bearer token. */
export function hasMcpBearerCredential(request: Request) {
	return readBearerToken(request.headers.get('Authorization')) !== null
}

function createUnauthorizedResponse(origin: string, kind: McpUnauthorizedKind) {
	// Keep a JSON body in addition to WWW-Authenticate. Some remote MCP clients
	// (notably Gemini custom connected apps) treat an empty 401 as a hard
	// connectivity failure and never start OAuth discovery / DCR. The library's
	// missing-bearer challenge is empty-bodied, so origin-handler short-circuits
	// that case through this helper before OAuthProvider runs.
	return Response.json(createUnauthorizedBody(kind), {
		status: 401,
		headers: {
			'WWW-Authenticate': buildWwwAuthenticateHeader(origin, kind),
		},
	})
}

export function createMcpMissingCredentialResponse(origin: string) {
	return createUnauthorizedResponse(origin, 'missing_credential')
}

function acceptsMediaType(accept: string, mediaType: string) {
	return accept.split(',').some((range) => {
		const [type, ...parameters] = range.trim().split(';')
		if (type?.trim() !== mediaType) return false
		const quality = parameters
			.map((parameter) => parameter.trim())
			.find((parameter) => parameter.startsWith('q='))
		return quality ? Number(quality.slice(2)) > 0 : true
	})
}

export function isBrowserMcpNavigation(request: Request) {
	if (request.method !== 'GET' || request.headers.has('Authorization')) {
		return false
	}
	const accept = request.headers.get('Accept')?.toLowerCase()
	if (!accept) return false
	return (
		acceptsMediaType(accept, 'text/html') &&
		!accept.includes('text/event-stream') &&
		!accept.includes('application/json')
	)
}

export function createMcpBrowserLandingResponse(request: Request) {
	const onboardingUrl = new URL('/onboarding', request.url).toString()
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kody MCP endpoint</title></head><body><main style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><p style="font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#57606a">Kody secure connection</p><h1>This endpoint is for AI agents</h1><p>You’ve reached Kody’s MCP endpoint. AI agents use this address to connect to Kody, so there isn’t anything to browse here.</p><p><a href="${onboardingUrl}">Follow the guide to connect your agent</a></p></main></body></html>`,
		{
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/html; charset=utf-8',
			},
		},
	)
}

/** CORS for browser-hosted MCP clients (Gemini custom apps, etc.). */
export function mcpCorsHeadersForRequest(
	request: Request,
): Record<string, string> | null {
	const origin = request.headers.get('Origin')
	if (!origin) return null
	return {
		'Access-Control-Allow-Origin': origin,
		'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			'Authorization, Content-Type, Accept, MCP-Protocol-Version, Last-Event-ID, Mcp-Session-Id',
		'Access-Control-Expose-Headers':
			'WWW-Authenticate, MCP-Session-Id, Content-Type',
		Vary: 'Origin',
	}
}

export function withMcpCors(request: Request, response: Response) {
	const cors = mcpCorsHeadersForRequest(request)
	if (!cors) return response
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(cors)) {
		headers.set(name, value)
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

export function createEmailVerificationRequiredResponse(origin: string) {
	return Response.json(
		{
			error: 'email_verification_required',
			error_description:
				'Your account email address is not verified, so MCP access is disabled. ' +
				`Open the verification link sent to your email, or resend it from ${origin}/account.`,
		},
		{ status: 403 },
	)
}

export function createAccountSuspendedResponse() {
	return Response.json(
		{
			error: 'account_suspended',
			error_description:
				'This account is suspended, so MCP access is disabled. ' +
				'Contact the operator of this Kody deployment to appeal.',
		},
		{ status: 403 },
	)
}

function createAccountDeletingResponse(status: 409 | 503) {
	return Response.json(
		{
			error: 'account_deleting',
			error_description:
				status === 503
					? 'Account deletion is in progress; retry after the current write finishes.'
					: 'Account deletion is in progress; user-owned writes are disabled.',
		},
		{ status },
	)
}

function audienceMatches(
	audience: string | Array<string> | undefined,
	origin: string,
) {
	if (!audience) return false
	const allowed = Array.isArray(audience) ? audience : [audience]
	const resource = mcpOAuthResourceUri(origin)
	// v1 audiences are exact against resourceMetadata.resource (`<origin>/mcp`).
	return allowed.some((value) => value === resource)
}

function tokenHasRequiredMcpScopes(scope: ReadonlyArray<string>) {
	return mcpOauthScopes.every((required) => scope.includes(required))
}

function resourceAuthFromTokenSummary(
	token: string,
	summary: TokenSummary,
	origin: string,
): OAuthResourceAuth {
	return {
		token,
		audience:
			typeof summary.audience === 'string'
				? summary.audience
				: mcpOAuthResourceUri(origin),
		expiresAt: summary.expiresAt,
		scope: [...(summary.scope ?? summary.grant.scope ?? [])],
		userId: summary.userId,
		clientId: summary.grant.clientId,
	}
}

/**
 * The account write lease fences mutating MCP traffic during deletion. Read-only
 * JSON-RPC (`initialize`, `tools/list`, `ping`, `search`) skips the UserMeter
 * RPCs and checks D1 `users.deleting_at` only. Unclassified bodies, JSON-RPC
 * batches that include a write, and any `tools/call` other than `search` keep
 * the full lease.
 */
export function mcpParsedBodyNeedsAccountWriteLease(parsedBody: unknown) {
	if (parsedBody === undefined) return true
	const messages = Array.isArray(parsedBody)
		? parsedBody.filter(isRecord)
		: isRecord(parsedBody)
			? [parsedBody]
			: []
	if (messages.length === 0) return true
	return messages.some((message) =>
		jsonRpcMessageNeedsAccountWriteLease(message),
	)
}

function jsonRpcMessageNeedsAccountWriteLease(
	message: Record<string, unknown>,
) {
	if (message['method'] !== 'tools/call') return false
	const params = isRecord(message['params']) ? message['params'] : null
	const name = typeof params?.['name'] === 'string' ? params['name'] : null
	return name !== 'search'
}

let statelessLaneMemo: Promise<typeof StatelessLane> | null = null

// The stateless lane pulls in the MCP server SDK; load it on the first MCP
// request instead of during Worker startup (see startup-budget.md).
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

// Capture an eagerly started promise so an early return above never leaves an
// unhandled rejection, and rethrow at the point the result is consumed.
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	)
}

function unsettle<T>(settled: Settled<T>): T {
	if (settled.ok) return settled.value
	throw settled.error
}

function loadStatelessLane() {
	statelessLaneMemo ??= import('./mcp/stateless-lane.ts').catch(
		(error: unknown) => {
			statelessLaneMemo = null
			throw error
		},
	)
	return statelessLaneMemo
}

export async function handleMcpRequest({
	request,
	env,
	ctx,
	fetchMcp,
}: {
	request: Request
	env: Env
	ctx: ExecutionContext
	fetchMcp: CustomExportedHandler<OAuthContextProps>['fetch']
}) {
	const url = new URL(request.url)
	const origin = getAppBaseUrl({
		env,
		requestUrl: url,
	})
	const recordRejection = async (
		reason: McpAuthDenialReason,
		email?: string,
	) => {
		await recordMcpAuthDenial({
			db: auditDatabaseFromEnv(env),
			action: 'mcp_token_rejected',
			reason,
			email,
			ip: getRequestIp(request),
			path: url.pathname,
		})
	}

	if (isBrowserMcpNavigation(request)) {
		return createMcpBrowserLandingResponse(request)
	}

	const context = ctx as OAuthExecutionContext
	const providerAuth = context.auth
	let tokenSummary: TokenSummary | null = null
	let accessToken: string | null = null

	if (providerAuth) {
		// OAuthProvider apiHandler already validated the bearer token and audience.
		accessToken = providerAuth.token
		tokenSummary = {
			id: 'provider',
			grantId: 'provider',
			userId: providerAuth.userId ?? '',
			createdAt: 0,
			expiresAt: providerAuth.expiresAt ?? 0,
			audience: providerAuth.audience,
			scope: providerAuth.scope,
			grant: {
				clientId: providerAuth.clientId ?? '',
				scope: providerAuth.scope,
				props: (context.props ?? null) as TokenSummary['grant']['props'],
			},
		}
		if (!tokenHasRequiredMcpScopes(providerAuth.scope)) {
			return insufficientScope(providerAuth, mcpOauthScopes)
		}
	} else {
		// Rejections before a grant resolves are deliberately not audited. They are
		// reachable by any anonymous request, so writing a row per attempt would let
		// a stranger drive unbounded D1 writes, and an unattributable "someone sent
		// a bad token" carries little signal on its own. Flood control for anonymous
		// traffic belongs at the edge; see docs/contributing/security.md.
		const token = readBearerToken(request.headers.get('Authorization'))
		if (token === null) {
			return createUnauthorizedResponse(origin, 'missing_credential')
		}
		accessToken = token

		const helpers = (env as OAuthEnv).OAUTH_PROVIDER
		if (!helpers) {
			return createUnauthorizedResponse(origin, 'invalid_token')
		}

		tokenSummary = await helpers.unwrapToken(token)
		if (!tokenSummary || !audienceMatches(tokenSummary.audience, origin)) {
			evictMcpAuthCache(token)
			return createUnauthorizedResponse(origin, 'invalid_token')
		}
		const scopes = tokenSummary.scope ?? tokenSummary.grant.scope ?? []
		if (!tokenHasRequiredMcpScopes(scopes)) {
			return insufficientScope(
				resourceAuthFromTokenSummary(token, tokenSummary, origin),
				mcpOauthScopes,
			)
		}
	}

	const grantProps = tokenSummary.grant.props ?? null
	// The user row, the org access epochs and (on a cache miss) the grant's
	// org binding and roles are read in one D1 batch (one transaction, one
	// round trip; see mcp-auth-cache.ts) and the provider-lane token re-unwrap
	// overlaps that read; every gate below still runs in the same order.
	const providerHelpers = providerAuth ? (env as OAuthEnv).OAUTH_PROVIDER : null
	const providerTokenPromise =
		providerHelpers && accessToken
			? settle(providerHelpers.unwrapToken(accessToken))
			: null
	const authContext = await buildMcpAuthContextCached(env, {
		grantProps,
		accessToken,
	})

	// Fail-closed email verification gate: every MCP request must map to an
	// account whose email is verified. Tokens without an identifiable user
	// are rejected too, since verification cannot be established for them. The
	// context loader reads identity, verification, and suspension in one query.
	if (!authContext) {
		evictMcpAuthCache(accessToken)
		await recordRejection('unidentified_grant')
		return createEmailVerificationRequiredResponse(origin)
	}
	const { user: mcpUser } = authContext.context
	if (!authContext.context.emailVerified) {
		evictMcpAuthCache(accessToken)
		await recordRejection('email_unverified', mcpUser.email)
		return createEmailVerificationRequiredResponse(origin)
	}

	// Fail-closed suspension gate, mirroring email verification: a
	// suspended account keeps its OAuth grants (stateless tokens cannot be
	// revoked individually) but every MCP request is rejected until an
	// admin clears the suspension.
	if (authContext.context.suspended) {
		evictMcpAuthCache(accessToken)
		await recordRejection('account_suspended', mcpUser.email)
		return createAccountSuspendedResponse()
	}

	// Password reset stamps password_changed_at and revokes grants. Already-
	// issued access tokens can still unwrap for up to an hour, so reject them
	// the same way browser cookies die — hosts then refresh, the revoked grant
	// fails, and they start a new OAuth flow.
	let tokenCreatedAtMs = tokenSummary.createdAt * 1000
	if (providerTokenPromise) {
		const unwrapped = unsettle(await providerTokenPromise)
		if (unwrapped) tokenCreatedAtMs = unwrapped.createdAt * 1000
	}
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: tokenCreatedAtMs,
			storedPasswordChangedAt: authContext.context.passwordChangedAt,
		})
	) {
		evictMcpAuthCache(accessToken)
		await recordRejection('password_changed', mcpUser.email)
		return createUnauthorizedResponse(origin, 'invalid_token')
	}

	const { orgBinding } = authContext
	if (!orgBinding || grantHasRetiredConnectionProfile(grantProps)) {
		evictMcpAuthCache(accessToken)
		await recordRejection('denied', mcpUser.email)
		return createUnauthorizedResponse(origin, 'invalid_token')
	}
	const callerContext = createMcpCallerContext({
		baseUrl: origin,
		source: { kind: 'mcp-oauth' },
		executionOrigin: 'interactive',
		user: mcpUser,
		oauthClientId: tokenSummary.grant.clientId,
		orgBinding,
	})
	context.props = toMcpCallerContextWire(callerContext)

	// Lane classification: 2025-era ("legacy") requests keep the sessionful
	// Durable Object McpAgent lane; 2026-07-28 envelope requests are served
	// by the stateless SDK v2 lane. Every authenticated request records a
	// lane data point so legacy-lane retirement is a metrics decision — see
	// ./mcp/protocol-metrics.ts for the readout query.
	const classification = await classifyMcpProtocolRequest(request)
	recordMcpProtocolEvent(env, {
		lane: classification.lane,
		method: classification.method,
		protocolVersion: classification.protocolVersion,
		clientName: classification.clientName,
		clientVersion: classification.clientVersion,
		packageIdentityParam: classification.packageIdentityParam,
		// person-keyed (not personal org)
		userId: personalOrgId(mcpUser.userId),
		requestHost: (() => {
			try {
				return new URL(request.url).hostname
			} catch {
				return ''
			}
		})(),
	})
	ctx.waitUntil(
		(async () => {
			const before = await env.APP_DB.prepare(
				`SELECT first_mcp_connected_at FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
			)
				.bind(personalOrgId(mcpUser.userId))
				.first<{ first_mcp_connected_at: string | null }>()
			await stampFirstMcpConnected(env.APP_DB, {
				stableUserId: personalOrgId(mcpUser.userId),
				clientName: classification.clientName || null,
			})
			if (!before?.first_mcp_connected_at) {
				scheduleKitSubscriberSync({
					env,
					stableUserId: personalOrgId(mcpUser.userId),
					email: mcpUser.email,
				})
			}
		})().catch((error) => {
			console.warn('mcp-first-connected-kit-sync-failed', error)
		}),
	)
	const inboundClientId = tokenSummary.grant.clientId?.trim()
	if (inboundClientId) {
		ctx.waitUntil(
			recordInboundMcpConnectionLastUsed({
				env,
				userId: personalOrgId(mcpUser.userId),
				clientId: inboundClientId,
			}).catch((error) => {
				console.warn('mcp-inbound-connection-last-used-failed', error)
			}),
		)
	}

	try {
		const legacyRequestIds =
			classification.lane === 'legacy'
				? extractJsonRpcRequestIds(classification.parsedBody)
				: []

		const serveMcp = async () => {
			const response =
				classification.lane === 'legacy'
					? await fetchMcp(
							request,
							env,
							context as ExecutionContext<OAuthContextProps>,
						)
					: await (
							await loadStatelessLane()
						).handleStatelessMcpRequest({
							request,
							env,
							ctx,
							callerContext,
							oauthClientId: inboundClientId || null,
							...(classification.parsedBody === undefined
								? {}
								: { parsedBody: classification.parsedBody }),
						})
			return guardLegacyLaneSseResponse(legacyRequestIds, response)
		}
		if (mcpParsedBodyNeedsAccountWriteLease(classification.parsedBody)) {
			return await withAccountWriteLease({
				db: env.APP_DB,
				stableUserId: personalOrgIdForPerson(mcpUser),
				holder: `mcp:${request.method} ${url.pathname}`,
				env,
				write: serveMcp,
			})
		}
		await assertAccountWritableDb(env.APP_DB, personalOrgIdForPerson(mcpUser))
		return await serveMcp()
	} catch (error) {
		if (error instanceof AccountDeletionInProgressError) {
			return createAccountDeletingResponse(409)
		}
		if (error instanceof AccountWriteLeaseLostError) {
			return createAccountDeletingResponse(503)
		}
		throw error
	}
}
