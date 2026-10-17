import { jsonResponse } from '#worker/json-response.ts'
import {
	type AuthRequest,
	CimdFetchError,
	type ClientInfo,
	type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { createCookie } from 'remix/cookie'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
	readParsedAuthSession,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { isAccountEmailVerified } from '#worker/identity/email-verification-state.ts'
import { getEnv } from '#app/env.ts'
import {
	type OAuthAuthorizeConsentOrg,
	type OAuthAuthorizeLoaderData,
} from '#universal/loader-data.ts'
import {
	personalOrgId,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { recordMcpConnectFunnelEvent } from '#worker/identity/onboarding-funnel.ts'
import { createDb, usersTable } from './db.ts'
import { upgradePasswordHashIfNeeded } from './password-upgrade.ts'
import { wantsJson } from './utils.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import { verifyPassword } from '@kody-internal/shared/password-hash.ts'
import { invalidClientIdMismatchMessage } from '@kody-internal/shared/oauth-messages.ts'
import {
	getUsernameFormatValidationError,
	resolveStoredDisplayName,
} from '#worker/identity/username.ts'
import { getPkceValidationError } from '#worker/oauth-pkce.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { stampAuthorizationResponseIssuer } from '#worker/oauth-authorization-response.ts'
import { mcpOAuthResourceUri } from '#worker/oauth-provider-options.ts'
import {
	listUserOAuthGrantsForClient,
	revokeOAuthGrant,
} from '#worker/oauth-grants.ts'
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
} from '#universal/onboarding-agent-ecosystems.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import { maybeEvaluateSecondAgentStandardGift } from '#worker/entitlements/second-agent-standard-gift.ts'
import {
	markUserMcpOauthClientRevokedByClientId,
	userOwnsMcpOauthClient,
} from '#app/account-mcp-oauth-clients.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import { deleteMcpEventSubscriptionsForOauthClient } from '#mcp/events/subscriptions-repo.ts'
import {
	isOAuthAuthorizeClobberedResubmit,
	oauthAuthorizeClobberedResubmitMessage,
} from '#worker/oauth-authorize-clobber.ts'
import {
	evaluateOidcAuthorizeGate,
	isOidcAuthorizeParamsParseError,
	parseOidcAuthorizeParams,
} from '#worker/oidc/authorize-oidc.ts'
import {
	connectionProfileGrantFields,
	resolveAuthorizeConnectionProfile,
} from '#worker/connection-profiles/oauth.ts'
import {
	ConnectionProfileAuthorizeError,
	isConnectionProfileAuthorizeError,
} from '#worker/connection-profiles/authorize-error.ts'
import { getConnectionProfileByName } from '#worker/connection-profiles/repo.ts'
import {
	readOrgSlugFromUrl,
	stripOrgFromResourceUri,
} from '#universal/org-binding/url.ts'
import { isOrgAuthorizeError } from '#worker/orgs/authorize-error.ts'
import {
	grantBindingFields,
	grantMatchesConsentOrg,
} from '#worker/orgs/oauth-grant.ts'
import {
	readOrgSlugFromForm,
	resolveAuthorizeOrg,
	selectConsentOrg,
	selectConsentOrgsForLoader,
	stripLoginFromAuthorizePrompt,
	type AuthorizeOrg,
} from '#worker/orgs/oauth-authorize.ts'
import { listOrgsForPerson } from '#worker/orgs/repo.ts'

export { oauthPaths }

export const oauthScopes = mcpOauthScopes
const invalidOAuthClientRegistrationMessage =
	'Invalid OAuth client registration.'
export const oauthEmailVerificationRequiredMessage =
	'Verify your account email before authorizing MCP access. Keep this page open, resend or open the verification link from Account in another tab, then continue.'

type OAuthEnv = Env & {
	OAUTH_PROVIDER: OAuthHelpers
}

function getValidOAuthUsername(value: unknown) {
	return typeof value === 'string' &&
		!getUsernameFormatValidationError(value.trim())
		? value.trim()
		: null
}

/** Soft-deleted people cannot authorize or reset OAuth (same as session auth). */
function liveOAuthUserRecord<T extends { deleted_at?: string | null }>(
	row: T | null | undefined,
): T | null {
	if (!row || row.deleted_at) return null
	return row
}

function isAuthorizeBindingError(error: unknown): error is { message: string } {
	return isOrgAuthorizeError(error) || isConnectionProfileAuthorizeError(error)
}

async function resolveAuthorizeOrgAndProfile(input: {
	authorizeUrl?: URL
	env: Env
	request: Request
	authRequest: AuthRequest
	userId: string
	formSlug?: string | null
}): Promise<{
	org: AuthorizeOrg
	connectionProfileName: string | null
}> {
	const urlOrg = await resolveAuthorizeOrg({
		env: input.env,
		request: input.request,
		authorizeUrl: input.authorizeUrl,
		authRequest: input.authRequest,
		userId: input.userId,
	})
	const org = await selectConsentOrg({
		db: input.env.APP_DB,
		userId: input.userId,
		formSlug: input.formSlug ?? null,
		urlOrg,
	})
	const connectionProfileName = await resolveAuthorizeConnectionProfile({
		env: input.env,
		request: input.request,
		authorizeUrl: input.authorizeUrl,
		authRequest: input.authRequest,
		userId: input.userId,
	})
	if (connectionProfileName) {
		const profile = await getConnectionProfileByName({
			db: input.env.APP_DB,
			userId: input.userId,
			name: connectionProfileName,
		})
		const profileOrgId =
			profile && typeof profile.orgId === 'string' ? profile.orgId.trim() : ''
		if (profileOrgId && profileOrgId !== org.orgId) {
			throw new ConnectionProfileAuthorizeError(
				`Connection profile "${connectionProfileName}" was not found in @${org.slug}.`,
			)
		}
	}
	return { org, connectionProfileName }
}

async function evaluateSecondAgentGiftAfterAuthorize(
	env: Env,
	stableUserId: OwnerId,
) {
	const inbound = await loadInboundMcpConnectionState(
		getOAuthHelpers(env),
		stableUserId,
	)
	const ecosystemCount = countConnectedAgentEcosystems(inbound.agents)
	if (!inbound.listingFailed && hasSecondConnectedMcpClient(inbound.agents)) {
		await maybeEvaluateSecondAgentStandardGift({
			db: env.APP_DB,
			stableUserId,
			ecosystemCount,
			listingFailed: inbound.listingFailed,
		})
	}
}

type OAuthClientResetVerification = {
	clientId: string
	reason: 'invalid-client-id-mismatch'
}

const dummyPasswordHash =
	'pbkdf2_sha256$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000'
const oauthClientResetVerificationCookieName = 'kody_oauth_client_reset'
const oauthClientResetVerificationMaxAgeSeconds = 60 * 5
// The website reset uses Start RPCs outside /oauth. Only this signed, short-lived
// verification cookie needs to span both transports.
const oauthClientResetVerificationCookiePath = '/'

let oauthClientResetVerificationCookie: ReturnType<typeof createCookie> | null =
	null
let oauthClientResetVerificationCookieSecret: string | null = null

function standaloneAuthorizeErrorHtmlResponse(message: string, status: number) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OAuth authorization failed</title></head><body><main style="font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem"><p style="font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#57606a">Kody secure connection</p><h1>Authorize access</h1><p>${message}</p><p><a href="/">Back home</a></p></main></body></html>`,
		{
			status,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/html; charset=utf-8',
			},
		},
	)
}

function getOAuthHelpers(env: Env) {
	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		throw new Error('OAuth provider helpers are not available.')
	}
	return helpers
}

function getOAuthClientResetVerificationCookie(secret: string) {
	if (
		oauthClientResetVerificationCookie &&
		oauthClientResetVerificationCookieSecret === secret
	) {
		return oauthClientResetVerificationCookie
	}

	oauthClientResetVerificationCookieSecret = secret
	oauthClientResetVerificationCookie = createCookie(
		oauthClientResetVerificationCookieName,
		{
			httpOnly: true,
			sameSite: 'Lax',
			path: oauthClientResetVerificationCookiePath,
			maxAge: oauthClientResetVerificationMaxAgeSeconds,
			secrets: [secret],
		},
	)
	return oauthClientResetVerificationCookie
}

function isOAuthClientResetVerification(
	value: unknown,
): value is OAuthClientResetVerification {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.clientId === 'string' &&
		record.clientId.length > 0 &&
		record.reason === 'invalid-client-id-mismatch'
	)
}

function requestHasOAuthClientResetVerificationCookie(request: Request) {
	const cookieHeader = request.headers.get('Cookie')
	return (
		cookieHeader?.includes(`${oauthClientResetVerificationCookieName}=`) ??
		false
	)
}

async function createOAuthClientResetVerificationCookie(
	request: Request,
	env: Env,
	verification: OAuthClientResetVerification,
) {
	const appEnv = getEnv(env)
	const cookie = getOAuthClientResetVerificationCookie(appEnv.COOKIE_SECRET)
	return [
		await cookie.serialize(JSON.stringify(verification), {
			secure: isSecureRequest(request),
		}),
		// Retire the pre-Start path so it cannot shadow the new cookie on /oauth.
		await cookie.serialize('', {
			path: '/oauth',
			secure: isSecureRequest(request),
			maxAge: 0,
			expires: new Date(0),
		}),
	]
}

async function destroyOAuthClientResetVerificationCookie(
	request: Request,
	env: Env,
) {
	const appEnv = getEnv(env)
	const cookie = getOAuthClientResetVerificationCookie(appEnv.COOKIE_SECRET)
	return Promise.all(
		['/', '/oauth'].map((path) =>
			cookie.serialize('', {
				path,
				secure: isSecureRequest(request),
				maxAge: 0,
				expires: new Date(0),
			}),
		),
	)
}

async function readOAuthClientResetVerification(
	request: Request,
	env: Env,
): Promise<OAuthClientResetVerification | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const appEnv = getEnv(env)
	const stored = await getOAuthClientResetVerificationCookie(
		appEnv.COOKIE_SECRET,
	).parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		return isOAuthClientResetVerification(parsed) ? parsed : null
	} catch {
		return null
	}
}

function createSetCookieHeaders(cookies: Array<string | null | undefined>) {
	const headers = new Headers()
	let hasCookie = false
	for (const cookie of cookies) {
		if (!cookie) continue
		headers.append('Set-Cookie', cookie)
		hasCookie = true
	}
	return hasCookie ? headers : undefined
}

function defaultMcpResourceForAuthRequest(
	authRequest: AuthRequest,
	request: Request,
	env: Env,
) {
	// Gemini Spark (and some other MCP hosts) omit RFC 8707 `resource` on
	// authorize. Without a grant resource, token exchange can mint a token with
	// no audience, and `/mcp` rejects it. Default to the MCP resource when the
	// client did not send one; explicit `resource` values are left unchanged.
	if (authRequest.resource !== undefined) return
	const origin = getAppBaseUrl({
		env,
		requestUrl: request.url,
	})
	authRequest.resource = mcpOAuthResourceUri(origin)
}

function isCimdMetadataResolutionError(error: unknown) {
	return (
		error instanceof CimdFetchError ||
		(error instanceof Error &&
			error.name === 'CimdFetchError' &&
			'metadataUrl' in error)
	)
}

async function resolveAuthRequest(
	helpers: OAuthHelpers,
	request: Request,
	env: Env,
	authorizeUrl?: URL,
) {
	try {
		// The provider parser consumes an HTTP authorize request. Keep this adapter
		// local: sessions, cookies, OIDC and organization checks retain the real request.
		const authRequest = await helpers.parseAuthRequest(
			authorizeUrl && authorizeUrl.href !== request.url
				? new Request(authorizeUrl, { headers: request.headers })
				: request,
		)
		if (!authRequest.clientId || !authRequest.redirectUri) {
			return {
				error:
					'Invalid OAuth request. Client ID and redirect URI are required.',
			}
		}
		const client = await helpers.lookupClient(authRequest.clientId)
		if (!client) {
			return { error: 'Unknown OAuth client.' }
		}
		defaultMcpResourceForAuthRequest(authRequest, request, env)
		// RFC 9207: completeAuthorization only adds `iss` when this field is
		// set. Always use the discovery issuer (`getAppBaseUrl`) so it cannot
		// drift from `/.well-known/openid-configuration`.
		authRequest.issuer = getAppBaseUrl({
			env,
			requestUrl: request.url,
		})
		return { authRequest, client }
	} catch (error) {
		if (isCimdMetadataResolutionError(error)) {
			return { error: 'Unknown OAuth client.' }
		}
		const message =
			error instanceof TypeError
				? invalidOAuthClientRegistrationMessage
				: error instanceof Error
					? error.message
					: 'Unable to parse OAuth request.'
		return { error: message }
	}
}

function readClientIdFromAuthorizeRequest(
	request: Request,
	authorizeUrl = new URL(request.url),
) {
	const clientId = authorizeUrl.searchParams.get('client_id')?.trim()
	return clientId ? clientId : null
}

function isLoopbackHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '::1' ||
		hostname.startsWith('127.')
	)
}

function redirectUriMatchesRegisteredUri(
	requestUri: string,
	registeredUris: Array<string>,
) {
	return registeredUris.some((registeredUri) => {
		try {
			const requestUrl = new URL(requestUri)
			const registeredUrl = new URL(registeredUri)
			if (
				isLoopbackHostname(requestUrl.hostname) &&
				isLoopbackHostname(registeredUrl.hostname)
			) {
				return (
					requestUrl.protocol === registeredUrl.protocol &&
					requestUrl.hostname === registeredUrl.hostname &&
					requestUrl.pathname === registeredUrl.pathname &&
					requestUrl.search === registeredUrl.search
				)
			}
		} catch {
			return false
		}
		return requestUri === registeredUri
	})
}

function readRegisteredRedirectUris(client: ClientInfo) {
	const redirectUris = (client as { redirectUris?: unknown }).redirectUris
	return Array.isArray(redirectUris) &&
		redirectUris.every((uri) => typeof uri === 'string')
		? redirectUris
		: null
}

async function requestHasRedirectUriMismatch(
	helpers: OAuthHelpers,
	request: Request,
	url = new URL(request.url),
) {
	const clientId = url.searchParams.get('client_id')?.trim()
	const redirectUri = url.searchParams.get('redirect_uri')?.trim()
	if (!clientId || !redirectUri) return false
	let client: ClientInfo | null
	try {
		client = await helpers.lookupClient(clientId)
	} catch {
		return false
	}
	if (!client) return false
	const registeredUris = readRegisteredRedirectUris(client)
	if (!registeredUris) return true
	return !redirectUriMatchesRegisteredUri(redirectUri, registeredUris)
}

function resolveScopes(requestedScopes: Array<string>) {
	if (requestedScopes.length === 0) return oauthScopes
	const invalidScopes = requestedScopes.filter(
		(scope) => !oauthScopes.includes(scope),
	)
	if (invalidScopes.length > 0) {
		return {
			error: `Unsupported scopes requested: ${invalidScopes.join(', ')}`,
		}
	}
	return requestedScopes
}

async function resolveAuthorizeInfoResetState(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
	errorMessage: string,
	authorizeUrl?: URL,
) {
	const shouldClearVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
	const redirectUriMismatch = await requestHasRedirectUriMismatch(
		helpers,
		request,
		authorizeUrl,
	)
	if (redirectUriMismatch) {
		return {
			allowClientReset: true,
			setCookies: shouldClearVerificationCookie
				? await destroyOAuthClientResetVerificationCookie(request, env)
				: [],
		}
	}

	if (errorMessage === invalidClientIdMismatchMessage) {
		const clientId = readClientIdFromAuthorizeRequest(request, authorizeUrl)
		if (clientId) {
			return {
				allowClientReset: true,
				setCookies: await createOAuthClientResetVerificationCookie(
					request,
					env,
					{
						clientId,
						reason: 'invalid-client-id-mismatch',
					},
				),
			}
		}
	}

	return {
		allowClientReset: false,
		setCookies: shouldClearVerificationCookie
			? await destroyOAuthClientResetVerificationCookie(request, env)
			: [],
	}
}

export type OAuthDecisionData = {
	ok: boolean
	error?: string
	code?: string
	redirectTo?: string
	message?: string
	requiresOrgChoice?: boolean
	requiresTwoFactor?: boolean
}
type OAuthDecisionResult = {
	data: OAuthDecisionData
	status: number
	headers: Headers
}
function decisionResult(
	data: OAuthDecisionData,
	options: { status?: number; headers?: HeadersInit } = {},
): OAuthDecisionResult {
	return {
		data,
		status: options.status ?? 200,
		headers: new Headers(options.headers),
	}
}
function decisionError(
	message: string,
	status = 400,
	code = 'invalid_request',
	headers?: HeadersInit,
): OAuthDecisionResult {
	return decisionResult(
		{ ok: false, error: message, code },
		{ status, headers },
	)
}

async function handleResetClientRequest(
	request: Request,
	env: Env,
	helpers: OAuthHelpers,
	requestIp: string | undefined,
	authorizeUrl: URL,
) {
	const clientId = readClientIdFromAuthorizeRequest(request, authorizeUrl)
	const hasResetVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
	const verifiedClientReset = await readOAuthClientResetVerification(
		request,
		env,
	)
	const clearResetVerificationCookie = hasResetVerificationCookie
		? await destroyOAuthClientResetVerificationCookie(request, env)
		: []
	const redirectUriMismatch = await requestHasRedirectUriMismatch(
		helpers,
		request,
		authorizeUrl,
	)
	const canResetStoredClient =
		redirectUriMismatch ||
		(clientId !== null && verifiedClientReset?.clientId === clientId)
	if (!canResetStoredClient) {
		return decisionError(
			'Stored client cleanup is only available for stale or mismatched client registrations.',
			400,
			'invalid_request',
			createSetCookieHeaders(clearResetVerificationCookie),
		)
	}

	if (!clientId) {
		return decisionError(
			'Missing client ID for stored client cleanup.',
			400,
			'invalid_request',
			createSetCookieHeaders(clearResetVerificationCookie),
		)
	}

	const { email: sessionEmail, setCookie } = await resolveSessionEmail(
		request,
		env,
	)
	if (!sessionEmail) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'reset_client',
			result: 'failure',
			ip: requestIp,
			clientId,
			reason: 'missing_session',
		})
		return decisionError(
			'Sign in before resetting this connection.',
			401,
			'unauthorized',
			createSetCookieHeaders(clearResetVerificationCookie),
		)
	}

	try {
		const db = createDb(env.APP_DB)
		const userRecord = liveOAuthUserRecord(
			await db.findOne(usersTable, {
				where: { email: sessionEmail },
			}),
		)
		if (!userRecord) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'reset_client',
				result: 'failure',
				email: sessionEmail,
				ip: requestIp,
				clientId,
				reason: 'user_not_found',
			})
			return decisionError(
				'Signed-in user not found.',
				401,
				'unauthorized',
				createSetCookieHeaders(clearResetVerificationCookie),
			)
		}
		const userId = personIdFromStored(userRecord.stable_user_id)
		const grants = await listUserOAuthGrantsForClient(helpers, userId, clientId)
		await Promise.all(
			grants.map((grant) => revokeOAuthGrant(helpers, grant.id, userId)),
		)
		const ownsClient = await userOwnsMcpOauthClient(
			env.APP_DB,
			userRecord.id,
			clientId,
		)
		if (ownsClient) {
			await helpers.deleteClient(clientId)
			await markUserMcpOauthClientRevokedByClientId(
				env.APP_DB,
				userRecord.id,
				clientId,
			)
		}
		await deleteMcpEventSubscriptionsForOauthClient({
			db: env.APP_DB,
			oauthClientId: clientId,
			...(ownsClient ? {} : { userId }),
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'reset_client',
			result: 'success',
			email: sessionEmail,
			ip: requestIp,
			clientId,
			reason: ownsClient ? 'deleted_owned_client' : 'revoked_grants_only',
		})
		return decisionResult(
			{
				ok: true,
				message: ownsClient
					? "Deleted your stored client registration and revoked this account's grants. Start the connection again from your client to create a fresh trusted client."
					: "Revoked this account's grants for the client. Shared client registrations stay in place. Start the connection again from your client.",
			},
			{
				headers: createSetCookieHeaders([
					...clearResetVerificationCookie,
					setCookie,
				]),
			},
		)
	} catch (error) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'reset_client',
			result: 'failure',
			email: sessionEmail,
			ip: requestIp,
			clientId,
			reason: error instanceof Error ? error.message : 'unknown_error',
		})
		return decisionError(
			'Unable to reset this connection right now.',
			500,
			'server_error',
			createSetCookieHeaders(clearResetVerificationCookie),
		)
	}
}

function stampClientAuthorizationRedirect(
	redirectTo: string,
	request: Request,
	env: Env,
) {
	return stampAuthorizationResponseIssuer(redirectTo, {
		env,
		requestUrl: request.url,
	})
}

function createAccessDeniedRedirectUrl(
	authRequest: AuthRequest,
	request: Request,
	env: Env,
) {
	if (!authRequest.redirectUri) {
		return null
	}
	const redirectUrl = new URL(authRequest.redirectUri)
	redirectUrl.searchParams.set('error', 'access_denied')
	if (authRequest.state)
		redirectUrl.searchParams.set('state', authRequest.state)
	return stampClientAuthorizationRedirect(redirectUrl.toString(), request, env)
}

function createOidcClientErrorRedirectUrl(
	authRequest: AuthRequest,
	errorCode: string,
	description: string,
	request: Request,
	env: Env,
) {
	if (!authRequest.redirectUri) return null
	const redirectUrl = new URL(authRequest.redirectUri)
	redirectUrl.searchParams.set('error', errorCode)
	redirectUrl.searchParams.set('error_description', description)
	if (authRequest.state)
		redirectUrl.searchParams.set('state', authRequest.state)
	return stampClientAuthorizationRedirect(redirectUrl.toString(), request, env)
}

function createAuthorizeErrorRedirect(
	request: Request,
	error: string,
	description: string,
	headersInit?: HeadersInit,
) {
	const redirectUrl = new URL(request.url)
	redirectUrl.searchParams.set('error', error)
	redirectUrl.searchParams.set('error_description', description)
	const headers = new Headers(headersInit)
	headers.set('Location', redirectUrl.toString())
	return new Response(null, {
		status: 303,
		headers,
	})
}

function respondAuthorizeError(
	request: Request,
	message: string,
	status = 400,
	errorCode = 'invalid_request',
	headers?: HeadersInit,
) {
	if (wantsJson(request)) {
		return jsonResponse(
			{ ok: false, error: message, code: errorCode },
			{ status, headers },
		)
	}
	// GET must not 303 back to /oauth/authorize with the same query string —
	// parse failures like malformed max_age would redirect forever.
	if (request.method === 'GET' || request.method === 'HEAD') {
		const response = standaloneAuthorizeErrorHtmlResponse(message, status)
		if (!headers) return response
		const merged = new Headers(response.headers)
		new Headers(headers).forEach((value, key) => {
			merged.append(key, value)
		})
		return new Response(response.body, {
			status: response.status,
			headers: merged,
		})
	}
	return createAuthorizeErrorRedirect(request, errorCode, message, headers)
}

async function resolveSessionEmail(request: Request, env: Env) {
	try {
		const appEnv = getEnv(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		const { session, setCookie } = await readAuthSessionResult(request)
		const email = session?.email?.trim()
		return {
			session,
			email: email ? email.toLowerCase() : null,
			setCookie,
		}
	} catch {
		return {
			session: null,
			email: null,
			setCookie: null,
		}
	}
}

async function resolveAuthorizeSession(request: Request, env: Env) {
	try {
		const appEnv = getEnv(env)
		setAuthSessionSecret(appEnv.COOKIE_SECRET)
		const parsed = await readParsedAuthSession(request)
		if (!parsed) {
			return {
				session: null,
				email: null,
				stableUserId: null,
				issuedAt: undefined,
				setCookie: null,
			}
		}
		const email = parsed.session.email.trim().toLowerCase()
		return {
			session: parsed.session,
			email,
			stableUserId: parsed.session.stableUserId,
			issuedAt: parsed.issuedAt,
			setCookie: parsed.setCookie,
		}
	} catch {
		return {
			session: null,
			email: null,
			stableUserId: null,
			issuedAt: undefined,
			setCookie: null,
		}
	}
}

export type OAuthAuthorizeDataResult = {
	data: OAuthAuthorizeLoaderData
	setCookies: Array<string | null>
}

export async function loadOAuthAuthorizeData(
	request: Request,
	env: Env,
	authorizeUrl = new URL(request.url),
): Promise<OAuthAuthorizeDataResult> {
	if (
		isOAuthAuthorizeClobberedResubmit({
			searchParams: authorizeUrl.searchParams,
		})
	) {
		return {
			data: {
				ok: false,
				error: oauthAuthorizeClobberedResubmitMessage,
				allowClientReset: false,
			},
			setCookies: [],
		}
	}
	const oidcParamsOrError = parseOidcAuthorizeParams(
		request,
		authorizeUrl.searchParams,
	)
	if (isOidcAuthorizeParamsParseError(oidcParamsOrError)) {
		return {
			data: {
				ok: false,
				error: oidcParamsOrError.error,
				allowClientReset: false,
			},
			setCookies: [],
		}
	}
	const oidcParams = oidcParamsOrError
	const helpers = getOAuthHelpers(env)
	const resolution = await resolveAuthRequest(
		helpers,
		request,
		env,
		authorizeUrl,
	)
	if ('error' in resolution) {
		const { allowClientReset, setCookies } =
			await resolveAuthorizeInfoResetState(
				request,
				env,
				helpers,
				resolution.error ?? 'Unable to parse OAuth request.',
				authorizeUrl,
			)
		return {
			data: {
				ok: false,
				error: resolution.error ?? 'Unable to parse OAuth request.',
				allowClientReset,
			},
			setCookies,
		}
	}

	const oidcGate = await evaluateOidcAuthorizeGate({
		params: oidcParams,
		session: await resolveAuthorizeSession(request, env).then((session) => ({
			sessionEmail: session.email,
			sessionStableUserId: session.stableUserId,
			sessionIssuedAt: session.issuedAt,
		})),
		request,
		env,
	})
	if (!oidcGate.ok) {
		return {
			data: {
				ok: false,
				error: oidcGate.error,
				allowClientReset: false,
			},
			setCookies: [],
		}
	}

	const { authRequest, client } = resolution
	const clearResetVerificationCookie =
		requestHasOAuthClientResetVerificationCookie(request)
			? await destroyOAuthClientResetVerificationCookie(request, env)
			: []
	const resolvedScopes = resolveScopes(authRequest.scope)
	if (!Array.isArray(resolvedScopes)) {
		return {
			data: {
				ok: false,
				error: resolvedScopes.error,
				allowClientReset: false,
			},
			setCookies: clearResetVerificationCookie,
		}
	}
	const authorizeSession = await resolveAuthorizeSession(request, env)
	const sessionSetCookie = authorizeSession.setCookie
	const requireCredentials = oidcGate.treatAsSignedOut
	const sessionEmail = requireCredentials ? null : authorizeSession.email
	let emailVerified: boolean | null = null
	if (sessionEmail) {
		emailVerified = await isAccountEmailVerified({
			db: env.APP_DB,
			email: sessionEmail,
			stableUserId: authorizeSession.stableUserId ?? undefined,
		})
	}
	if (!requireCredentials && authorizeSession.stableUserId) {
		recordMcpConnectFunnelEvent(env, {
			stage: 'mcp_connect_started',
			userId: authorizeSession.stableUserId,
			clientId: client.clientId,
			clientName: client.clientName,
		})
	}

	let orgs: Array<OAuthAuthorizeConsentOrg> = []
	let selectedOrgSlug: string | null = readOrgSlugFromUrl(authorizeUrl.href)
	if (!requireCredentials && authorizeSession.stableUserId) {
		// Match approve: resolve `?org=` from the authorize URL and resource
		// before auto-selecting. Fail closed when the client named an
		// inaccessible or conflicting org, so the consent screen cannot look
		// ready and then reject on submit.
		let resolvedRequested: AuthorizeOrg | null = null
		try {
			resolvedRequested = await resolveAuthorizeOrg({
				authorizeUrl,
				env,
				request,
				authRequest,
				userId: authorizeSession.stableUserId,
			})
		} catch (error) {
			if (isOrgAuthorizeError(error)) {
				return {
					data: {
						ok: false,
						error: error.message,
						allowClientReset: false,
					},
					setCookies: [...clearResetVerificationCookie, sessionSetCookie],
				}
			}
			throw error
		}
		const accessible = await listOrgsForPerson(
			env.APP_DB,
			authorizeSession.stableUserId,
		)
		const consent = selectConsentOrgsForLoader(
			accessible,
			resolvedRequested?.slug ?? null,
		)
		orgs = consent.orgs
		selectedOrgSlug = consent.selectedOrgSlug
	}

	return {
		data: {
			ok: true,
			client: {
				id: client.clientId,
				name: client.clientName ?? client.clientId,
			},
			scopes: resolvedScopes,
			emailVerified,
			requireCredentials,
			orgs,
			selectedOrgSlug,
		},
		setCookies: [...clearResetVerificationCookie, sessionSetCookie],
	}
}

export async function handleAuthorizeInfo(
	request: Request,
	env: Env,
): Promise<Response> {
	const { data, setCookies } = await loadOAuthAuthorizeData(request, env)
	if (!data.ok) {
		return jsonResponse(
			{ ok: false, error: data.error, allowClientReset: data.allowClientReset },
			{
				status: 400,
				headers: createSetCookieHeaders(setCookies),
			},
		)
	}

	return jsonResponse(
		{
			ok: true,
			client: data.client,
			scopes: data.scopes,
			emailVerified: data.emailVerified,
			requireCredentials: data.requireCredentials,
			orgs: data.orgs,
			selectedOrgSlug: data.selectedOrgSlug,
		},
		{
			headers: createSetCookieHeaders(setCookies),
		},
	)
}

export function handleAuthorizeRouteException(
	request: Request,
): Promise<Response> | Response {
	const url = new URL(request.url)
	if (url.pathname === oauthPaths.authorizeInfo) {
		return jsonResponse(
			{
				ok: false,
				error: 'Unable to load authorization details.',
				allowClientReset: false,
			},
			{ status: 500 },
		)
	}

	const message =
		'OAuth authorization failed. Please start the connection again.'
	if (wantsJson(request)) {
		return jsonResponse(
			{ ok: false, error: message, code: 'server_error' },
			{ status: 500 },
		)
	}

	if (request.method === 'POST') {
		return createAuthorizeErrorRedirect(request, 'server_error', message)
	}

	return standaloneAuthorizeErrorHtmlResponse(message, 500)
}

export async function tryHandleSilentOidcAuthorize(
	request: Request,
	env: Env,
): Promise<Response | null> {
	const prompts =
		new URL(request.url).searchParams
			.get('prompt')
			?.trim()
			.split(/\s+/)
			.filter(Boolean) ?? []
	if (!prompts.includes('none')) return null

	const oidcClientErrorRedirect = (
		authRequest: AuthRequest,
		errorCode: string,
		description: string,
	) =>
		createOidcClientErrorRedirectUrl(
			authRequest,
			errorCode,
			description,
			request,
			env,
		)

	const oidcParamsOrError = parseOidcAuthorizeParams(request)
	if (isOidcAuthorizeParamsParseError(oidcParamsOrError)) {
		const helpers = getOAuthHelpers(env)
		const resolution = await resolveAuthRequest(helpers, request, env)
		if (!('error' in resolution)) {
			const redirectTo = oidcClientErrorRedirect(
				resolution.authRequest,
				oidcParamsOrError.errorCode,
				oidcParamsOrError.error,
			)
			if (redirectTo) return Response.redirect(redirectTo, 302)
		}
		return respondAuthorizeError(
			request,
			oidcParamsOrError.error,
			400,
			oidcParamsOrError.errorCode,
		)
	}
	const oidcParams = oidcParamsOrError

	const helpers = getOAuthHelpers(env)
	const resolution = await resolveAuthRequest(helpers, request, env)
	if ('error' in resolution) {
		return respondAuthorizeError(
			request,
			resolution.error ?? 'Unable to process OAuth request.',
		)
	}

	const { authRequest } = resolution
	const authorizeSession = await resolveAuthorizeSession(request, env)
	const oidcGate = await evaluateOidcAuthorizeGate({
		params: oidcParams,
		session: {
			sessionEmail: authorizeSession.email,
			sessionStableUserId: authorizeSession.stableUserId,
			sessionIssuedAt: authorizeSession.issuedAt,
		},
		request,
		env,
	})
	if (!oidcGate.ok) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			oidcGate.errorCode,
			oidcGate.error,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			oidcGate.error,
			oidcGate.status ?? 400,
			oidcGate.errorCode,
		)
	}
	if (!oidcGate.silentAuthorize) return null

	const pkceError = getPkceValidationError({
		codeChallenge: authRequest.codeChallenge,
		codeChallengeMethod: authRequest.codeChallengeMethod,
	})
	if (pkceError) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'invalid_request',
			pkceError,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, pkceError)
	}

	if (!authorizeSession.email || !authorizeSession.stableUserId) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'login_required',
			'Login required.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			'Login required.',
			401,
			'login_required',
		)
	}

	const db = createDb(env.APP_DB)
	const userRecord = liveOAuthUserRecord(
		await db.findOne(usersTable, {
			where: { stable_user_id: authorizeSession.stableUserId },
		}),
	)
	if (!userRecord) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'login_required',
			'Signed-in user not found.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, 'Signed-in user not found.', 401)
	}
	const username = getValidOAuthUsername(userRecord.username)
	if (!username) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'interaction_required',
			'Username is required.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, 'Username is required.', 401)
	}

	const approvedEmail = userRecord.email.trim().toLowerCase()
	const approvedUserId = personIdFromStored(userRecord.stable_user_id)
	recordMcpConnectFunnelEvent(env, {
		stage: 'mcp_connect_started',
		userId: approvedUserId,
		clientId: authRequest.clientId,
	})
	const emailVerified = await isAccountEmailVerified({
		db: env.APP_DB,
		email: approvedEmail,
		stableUserId: approvedUserId,
	})
	if (!emailVerified) {
		recordMcpConnectFunnelEvent(env, {
			stage: 'mcp_connect_failed',
			userId: approvedUserId,
			clientId: authRequest.clientId,
			errorClass: 'email_verification_required',
		})
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'interaction_required',
			oauthEmailVerificationRequiredMessage,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			oauthEmailVerificationRequiredMessage,
			403,
			'email_verification_required',
		)
	}

	const resolvedScopes = resolveScopes(authRequest.scope)
	if (!Array.isArray(resolvedScopes)) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'invalid_scope',
			resolvedScopes.error,
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(request, resolvedScopes.error)
	}

	const authTime = authorizeSession.issuedAt
		? Math.floor(authorizeSession.issuedAt / 1000)
		: Math.floor(Date.now() / 1000)
	let authorizeOrg: AuthorizeOrg
	let connectionProfileName: string | null
	try {
		const resolved = await resolveAuthorizeOrgAndProfile({
			env,
			request,
			authRequest,
			userId: approvedUserId,
		})
		authorizeOrg = resolved.org
		connectionProfileName = resolved.connectionProfileName
	} catch (error) {
		if (isAuthorizeBindingError(error)) {
			const redirectTo = oidcClientErrorRedirect(
				authRequest,
				'invalid_request',
				error.message,
			)
			if (redirectTo) return Response.redirect(redirectTo, 302)
			return respondAuthorizeError(request, error.message)
		}
		throw error
	}

	const existingGrants = await listUserOAuthGrantsForClient(
		helpers,
		approvedUserId,
		authRequest.clientId,
	)
	const hasMatchingConsent = existingGrants.some(
		(grant) =>
			resolvedScopes.every((scope) => grant.scope.includes(scope)) &&
			grantMatchesConsentOrg({
				metadata: grant.metadata,
				userId: approvedUserId,
				orgId: authorizeOrg.orgId,
			}),
	)
	if (!hasMatchingConsent) {
		const redirectTo = oidcClientErrorRedirect(
			authRequest,
			'consent_required',
			'Consent is required for this client.',
		)
		if (redirectTo) return Response.redirect(redirectTo, 302)
		return respondAuthorizeError(
			request,
			'Consent is required for this client.',
			401,
			'consent_required',
		)
	}
	const profileFields = connectionProfileGrantFields(connectionProfileName)
	const bindingFields = grantBindingFields({
		orgId: authorizeOrg.orgId,
		personId: approvedUserId,
	})
	const { redirectTo: providerRedirectTo } =
		await helpers.completeAuthorization({
			request: authRequest,
			userId: approvedUserId,
			metadata: {
				email: approvedEmail,
				clientId: authRequest.clientId,
				...profileFields.metadata,
				...bindingFields.metadata,
			},
			scope: resolvedScopes,
			props: {
				userId: approvedUserId,
				email: approvedEmail,
				username,
				displayName: resolveStoredDisplayName(
					userRecord.display_name,
					username,
				),
				authTime,
				...(oidcParams.nonce ? { nonce: oidcParams.nonce } : {}),
				...profileFields.props,
				...bindingFields.props,
			},
		})
	const redirectTo = stampClientAuthorizationRedirect(
		providerRedirectTo,
		request,
		env,
	)
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'authorize',
		result: 'success',
		email: approvedEmail,
		ip: getRequestIp(request) ?? undefined,
		clientId: authRequest.clientId,
	})
	recordMcpConnectFunnelEvent(env, {
		stage: 'mcp_connect_succeeded',
		userId: approvedUserId,
		clientId: authRequest.clientId,
	})
	await evaluateSecondAgentGiftAfterAuthorize(
		env,
		personalOrgId(approvedUserId),
	)
	return Response.redirect(redirectTo, 302)
}

export async function handleAuthorizeRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST')
		return new Response('Method not allowed', { status: 405 })
	const formData = await request.formData().catch(() => null)
	const result = await decideOAuthAuthorization({
		request,
		env,
		authorizeUrl: new URL(request.url),
		formData,
	})
	if (wantsJson(request) || result.data.message)
		return jsonResponse(result.data, {
			status: result.status,
			headers: result.headers,
		})
	if (result.data.redirectTo) {
		result.headers.set('Location', result.data.redirectTo)
		return new Response(null, { status: 302, headers: result.headers })
	}
	return respondAuthorizeError(
		request,
		result.data.error ?? 'Unable to complete authorization.',
		result.status,
		result.data.code,
		result.headers,
	)
}

export async function decideOAuthAuthorization({
	request,
	env,
	authorizeUrl,
	formData,
}: {
	request: Request
	env: Env
	authorizeUrl: URL
	formData: FormData | null
}): Promise<OAuthDecisionResult> {
	if (
		authorizeUrl.origin !== new URL(request.url).origin ||
		authorizeUrl.pathname !== '/oauth/authorize' ||
		authorizeUrl.hash
	)
		throw new Error('Invalid authorization URL')
	const requestIp = getRequestIp(request) ?? undefined
	const helpers = getOAuthHelpers(env)
	const oidcParamsOrError = parseOidcAuthorizeParams(
		request,
		authorizeUrl.searchParams,
	)
	if (isOidcAuthorizeParamsParseError(oidcParamsOrError)) {
		return decisionError(
			oidcParamsOrError.error,
			400,
			oidcParamsOrError.errorCode,
		)
	}
	const oidcParams = oidcParamsOrError
	const oidcGate = await evaluateOidcAuthorizeGate({
		params: oidcParams,
		session: await resolveAuthorizeSession(request, env).then((session) => ({
			sessionEmail: session.email,
			sessionStableUserId: session.stableUserId,
			sessionIssuedAt: session.issuedAt,
		})),
		request,
		env,
	})
	if (!oidcGate.ok) {
		return decisionError(
			oidcGate.error,
			oidcGate.status ?? 400,
			oidcGate.errorCode,
		)
	}

	if (!formData) return decisionError('Invalid form data')

	if (
		isOAuthAuthorizeClobberedResubmit({
			searchParams: authorizeUrl.searchParams,
			formData,
		})
	) {
		return decisionError(oauthAuthorizeClobberedResubmitMessage)
	}
	const decision = String(formData.get('decision') ?? 'approve')
	if (decision === 'reset-client') {
		return handleResetClientRequest(
			request,
			env,
			helpers,
			requestIp,
			authorizeUrl,
		)
	}

	const resolution = await resolveAuthRequest(
		helpers,
		request,
		env,
		authorizeUrl,
	)
	if ('error' in resolution) {
		return decisionError(resolution.error ?? 'Unable to process OAuth request.')
	}

	const { authRequest } = resolution
	// Reading the fields off the typed `AuthRequest` (rather than passing the
	// whole object) makes provider field renames a compile-time error here.
	const pkceError = getPkceValidationError({
		codeChallenge: authRequest.codeChallenge,
		codeChallengeMethod: authRequest.codeChallengeMethod,
	})
	if (pkceError) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'authorize',
			result: 'failure',
			ip: requestIp,
			clientId: authRequest.clientId,
			reason: 'invalid_pkce_method',
		})
		return decisionError(pkceError)
	}

	if (decision === 'deny') {
		const redirectTo = createAccessDeniedRedirectUrl(authRequest, request, env)
		if (!redirectTo) {
			return decisionError('Missing redirect URI for access denial.')
		}
		return decisionResult({ ok: true, redirectTo })
	}

	const email = String(formData.get('email') ?? '').trim()
	const password = String(formData.get('password') ?? '')
	const normalizedEmail = email.toLowerCase()
	const authorizeSession = await resolveAuthorizeSession(request, env)
	let setCookie = authorizeSession.setCookie
	const sessionEmail = oidcGate.treatAsSignedOut ? null : authorizeSession.email
	const session = oidcGate.treatAsSignedOut ? null : authorizeSession.session
	const hasFormCredentials = Boolean(email && password)
	const hasSession = Boolean(sessionEmail)

	if (oidcGate.forbidInlineLogin && hasFormCredentials) {
		return decisionError(
			'Interactive login is not allowed for this authorization request.',
			400,
			'interaction_required',
		)
	}

	if (!hasFormCredentials && !hasSession) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'authorize',
			result: 'failure',
			email: normalizedEmail || undefined,
			ip: requestIp,
			clientId: authRequest.clientId,
			reason: 'missing_credentials',
		})
		return decisionError('Email and password are required.')
	}

	let approvedEmail = ''
	let approvedUsername = ''
	let approvedDisplayName = ''
	let approvedUserId = ''
	let requiresOrgChoiceReload = false
	if (hasFormCredentials) {
		const db = createDb(env.APP_DB)
		const userRecord = liveOAuthUserRecord(
			await db.findOne(usersTable, {
				where: { email: normalizedEmail },
			}),
		)
		let passwordValid = false
		if (userRecord) {
			passwordValid = await verifyPassword(password, userRecord.password_hash)
		} else {
			await verifyPassword(password, dummyPasswordHash)
		}

		if (!userRecord || !passwordValid) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'invalid_credentials',
			})
			if (userRecord) {
				recordMcpConnectFunnelEvent(env, {
					stage: 'mcp_connect_started',
					userId: personIdFromStored(userRecord.stable_user_id),
					clientId: authRequest.clientId,
				})
				recordMcpConnectFunnelEvent(env, {
					stage: 'mcp_connect_failed',
					userId: personIdFromStored(userRecord.stable_user_id),
					clientId: authRequest.clientId,
					errorClass: 'invalid_credentials',
				})
			}
			return decisionError('Invalid email or password.')
		}
		try {
			await upgradePasswordHashIfNeeded(
				db,
				userRecord.id,
				password,
				userRecord.password_hash,
			)
		} catch {
			// A failed hash upgrade must never block an otherwise valid login.
		}
		const username = getValidOAuthUsername(userRecord.username)
		if (!username) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: normalizedEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'username_missing',
			})
			return decisionError('Username is required.', 401)
		}
		// Password alone is not enough when 2FA is on: park a pending verify
		// cookie and send the user through /verify (TOTP), then resume authorize
		// without prompt=login / id_token_hint so consent can use the new session.
		if (await isTwoFactorEnabled(env.APP_DB, userRecord.id)) {
			const stableUserId = personIdFromStored(userRecord.stable_user_id)
			setVerifySessionSecret(env.COOKIE_SECRET)
			const secure = isSecureRequest(request)
			const verifyCookie = await createVerifySessionCookie(
				{
					stableUserId,
					email: normalizedEmail,
					rememberMe: false,
				},
				secure,
			)
			const clearSessionCookie = await destroyAuthCookie(secure)
			const authorizeResume = stripLoginFromAuthorizePrompt(
				`${authorizeUrl.pathname}${authorizeUrl.search}`,
			)
			const redirectTo = `/verify?redirectTo=${encodeURIComponent(authorizeResume)}`
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'authorize_2fa_challenge',
				result: 'success',
				email: normalizedEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
			})
			recordMcpConnectFunnelEvent(env, {
				stage: 'mcp_connect_started',
				userId: stableUserId,
				clientId: authRequest.clientId,
			})
			const headers = createSetCookieHeaders([verifyCookie, clearSessionCookie])
			return decisionResult(
				{ ok: true, redirectTo, requiresTwoFactor: true },
				{ headers },
			)
		}
		approvedEmail = normalizedEmail
		approvedUsername = username
		approvedDisplayName = resolveStoredDisplayName(
			userRecord.display_name,
			username,
		)
		approvedUserId = personIdFromStored(userRecord.stable_user_id)
		// Inline login never saw the org picker (loader had no session). After
		// email verification, establish a browser session and reload authorize
		// when the account has several orgs and neither the form, authorize
		// URL, nor OAuth resource named an org, so the picker can render.
		// Peek only — do not call resolveAuthorizeOrg here; it strips `?org=`
		// from authRequest.resource and would hide a resource-only org from
		// the later approval resolve.
		const formOrgSlug = readOrgSlugFromForm(formData)
		const urlOrgSlug = readOrgSlugFromUrl(authorizeUrl.href)
		const resourceOrgSlug =
			typeof authRequest.resource === 'string'
				? stripOrgFromResourceUri(authRequest.resource).orgSlug
				: null
		if (!formOrgSlug && !urlOrgSlug && !resourceOrgSlug) {
			const accessible = await listOrgsForPerson(env.APP_DB, approvedUserId)
			requiresOrgChoiceReload = accessible.length > 1
		}
	} else if (sessionEmail) {
		const db = createDb(env.APP_DB)
		const userRecord = liveOAuthUserRecord(
			session?.stableUserId
				? await db.findOne(usersTable, {
						where: { stable_user_id: session.stableUserId },
					})
				: await db.findOne(usersTable, { where: { email: sessionEmail } }),
		)
		if (!userRecord) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: sessionEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'session_user_not_found',
			})
			return decisionError('Signed-in user not found.', 401)
		}
		const username = getValidOAuthUsername(userRecord.username)
		if (!username) {
			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'authorize',
				result: 'failure',
				email: sessionEmail,
				ip: requestIp,
				clientId: authRequest.clientId,
				reason: 'username_missing',
			})
			return decisionError('Username is required.', 401)
		}
		approvedEmail = userRecord.email.trim().toLowerCase()
		approvedUsername = username
		approvedDisplayName = resolveStoredDisplayName(
			userRecord.display_name,
			username,
		)
		approvedUserId = personIdFromStored(userRecord.stable_user_id)
		if (session && approvedEmail !== sessionEmail) {
			setCookie = await createAuthCookie(
				{
					stableUserId: session.stableUserId,
					email: approvedEmail,
					rememberMe: session.rememberMe,
				},
				isSecureRequest(request),
			)
		}
	}

	const emailVerified = await isAccountEmailVerified({
		db: env.APP_DB,
		email: approvedEmail,
		stableUserId: approvedUserId,
	})
	recordMcpConnectFunnelEvent(env, {
		stage: 'mcp_connect_started',
		userId: approvedUserId,
		clientId: authRequest.clientId,
	})
	if (!emailVerified) {
		recordMcpConnectFunnelEvent(env, {
			stage: 'mcp_connect_failed',
			userId: approvedUserId,
			clientId: authRequest.clientId,
			errorClass: 'email_verification_required',
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'authorize',
			result: 'failure',
			email: approvedEmail,
			ip: requestIp,
			clientId: authRequest.clientId,
			reason: 'email_verification_required',
		})
		return decisionError(
			oauthEmailVerificationRequiredMessage,
			403,
			'email_verification_required',
			createSetCookieHeaders([setCookie]),
		)
	}

	if (hasFormCredentials) {
		setCookie = await createAuthCookie(
			{
				stableUserId: approvedUserId,
				email: approvedEmail,
				rememberMe: false,
			},
			isSecureRequest(request),
		)
		if (requiresOrgChoiceReload) {
			const reloadTo = stripLoginFromAuthorizePrompt(authorizeUrl.href)
			const cookieHeaders = createSetCookieHeaders([setCookie])
			return decisionResult(
				{ ok: true, redirectTo: reloadTo, requiresOrgChoice: true },
				{ headers: cookieHeaders },
			)
		}
	}

	const resolvedScopes = resolveScopes(authRequest.scope)
	if (Array.isArray(resolvedScopes)) {
		const userId = approvedUserId
		const displayName = approvedDisplayName || approvedUsername
		const authTime = hasFormCredentials
			? Math.floor(Date.now() / 1000)
			: authorizeSession.issuedAt
				? Math.floor(authorizeSession.issuedAt / 1000)
				: Math.floor(Date.now() / 1000)
		let authorizeOrg: AuthorizeOrg
		let connectionProfileName: string | null
		try {
			const resolved = await resolveAuthorizeOrgAndProfile({
				authorizeUrl,
				env,
				request,
				authRequest,
				userId,
				formSlug: readOrgSlugFromForm(formData),
			})
			authorizeOrg = resolved.org
			connectionProfileName = resolved.connectionProfileName
		} catch (error) {
			if (isAuthorizeBindingError(error)) {
				const redirectTo = createOidcClientErrorRedirectUrl(
					authRequest,
					'invalid_request',
					error.message,
					request,
					env,
				)
				if (redirectTo) {
					return decisionResult({
						ok: false,
						error: error.message,
						redirectTo,
					})
				}
				return decisionError(
					error.message,
					400,
					'invalid_request',
					createSetCookieHeaders([setCookie]),
				)
			}
			throw error
		}
		const profileFields = connectionProfileGrantFields(connectionProfileName)
		const bindingFields = grantBindingFields({
			orgId: authorizeOrg.orgId,
			personId: userId,
		})
		const { redirectTo: providerRedirectTo } =
			await helpers.completeAuthorization({
				request: authRequest,
				userId,
				metadata: {
					email: approvedEmail,
					clientId: authRequest.clientId,
					...profileFields.metadata,
					...bindingFields.metadata,
				},
				scope: resolvedScopes,
				props: {
					userId,
					email: approvedEmail,
					username: approvedUsername,
					displayName,
					authTime,
					...(oidcParams.nonce ? { nonce: oidcParams.nonce } : {}),
					...profileFields.props,
					...bindingFields.props,
				},
			})
		const redirectTo = stampClientAuthorizationRedirect(
			providerRedirectTo,
			request,
			env,
		)
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'authorize',
			result: 'success',
			email: approvedEmail,
			ip: requestIp,
			clientId: authRequest.clientId,
		})
		recordMcpConnectFunnelEvent(env, {
			stage: 'mcp_connect_succeeded',
			userId,
			clientId: authRequest.clientId,
		})
		await evaluateSecondAgentGiftAfterAuthorize(
			env,
			personalOrgId(personIdFromStored(userId)),
		)
		return decisionResult(
			{ ok: true, redirectTo },
			{ headers: createSetCookieHeaders([setCookie]) },
		)
	}

	return decisionError(resolvedScopes.error)
}

/**
 * Legacy OAuth-protected JSON helper for grant props. Remains outside the MCP
 * resource (`/mcp`); callers present a Bearer token minted for this origin's
 * MCP audience. Not the OIDC UserInfo endpoint.
 */
export async function handleOAuthProtectedApiMe(request: Request, env: Env) {
	const url = new URL(request.url)
	if (url.pathname !== '/api/me') {
		return jsonResponse({ error: 'Not found' }, { status: 404 })
	}
	const authorization = request.headers.get('Authorization')
	const match = authorization?.match(/^Bearer(?:\s+(.*))?$/i)
	const token = match?.[1]?.trim() ?? ''
	if (!token) {
		return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 })
	}
	const helpers = (env as Partial<OAuthEnv>).OAUTH_PROVIDER
	if (!helpers) {
		return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 })
	}
	const summary = await helpers.unwrapToken(token)
	const origin = getAppBaseUrl({ env, requestUrl: request.url })
	const expectedAudience = mcpOAuthResourceUri(origin)
	const audience = summary?.audience
	const audienceOk =
		typeof audience === 'string'
			? audience === expectedAudience
			: Array.isArray(audience) && audience.includes(expectedAudience)
	if (!summary || !audienceOk) {
		return jsonResponse({ ok: false, error: 'Unauthorized' }, { status: 401 })
	}
	return jsonResponse({ ok: true, user: summary.grant.props })
}
