import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { mcpOauthScopes } from '#worker/mcp-oauth-scopes.ts'
import { mcpOAuthResourceUri } from '#worker/oauth-provider-options.ts'
import { checkRateLimit, type RateLimitConfig } from '#worker/rate-limit.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { normalizeOrgSlug } from '#universal/org-binding/url.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import {
	deviceCodeTtlSeconds,
	devicePollIntervalSeconds,
	formatUserCode,
	generateDeviceCode,
	generateUserCode,
	hashDeviceCode,
	isDeviceGrantClientAllowed,
} from './device-grant.ts'
import {
	oauthErrorResponse,
	readFormValue,
	readOAuthForm,
} from './oauth-errors.ts'
import {
	insertDeviceAuthorization,
	nowSeconds,
	purgeExpiredDeviceAuthorizations,
} from './store.ts'

/** Device authorization starts per IP. A CLI login needs one. */
export const deviceAuthorizationStartRateLimit: RateLimitConfig = {
	maxRequests: 10,
	windowSeconds: 60,
}

export const deviceGrantUnauthorizedClientMessage =
	'The device authorization grant is only available to the official Kody CLI.'

/**
 * Scopes are the OIDC trio (ADR 0049). An omitted scope means all three, as on
 * `/oauth/authorize`.
 */
export function resolveDeviceScopes(scope: string | null) {
	const requested = (scope ?? '').split(/\s+/).filter(Boolean)
	if (requested.length === 0)
		return { ok: true as const, scopes: mcpOauthScopes }
	const unsupported = requested.filter(
		(value) => !mcpOauthScopes.includes(value),
	)
	if (unsupported.length > 0) {
		return {
			ok: false as const,
			error: `Unsupported scopes requested: ${unsupported.join(', ')}`,
		}
	}
	return { ok: true as const, scopes: [...new Set(requested)] }
}

/** `POST /oauth/device_authorization` (RFC 8628 section 3.1). */
export async function handleDeviceAuthorizationRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', {
			status: 405,
			headers: { Allow: 'POST' },
		})
	}
	const appOrigin = getAppBaseUrl({ env, requestUrl: request.url })
	const ip = getRequestIp(request) ?? 'unknown'
	const limit = await checkRateLimit(
		env.APP_DB,
		`oauth-device:start:ip:${ip}`,
		deviceAuthorizationStartRateLimit,
	)
	if (!limit.allowed) {
		return oauthErrorResponse(
			'slow_down',
			'Too many device sign-in requests. Wait a minute and try again.',
			429,
			{},
		)
	}
	const form = await readOAuthForm(request)
	if (!form) {
		return oauthErrorResponse(
			'invalid_request',
			'Send the request as application/x-www-form-urlencoded.',
		)
	}
	const clientId = readFormValue(form, 'client_id')
	if (!clientId) {
		return oauthErrorResponse('invalid_request', 'client_id is required.')
	}
	if (!isDeviceGrantClientAllowed(appOrigin, clientId)) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'oauth',
			action: 'device_authorization',
			result: 'failure',
			ip,
			clientId,
			reason: 'unauthorized_client',
		})
		return oauthErrorResponse(
			'unauthorized_client',
			deviceGrantUnauthorizedClientMessage,
		)
	}
	const scopes = resolveDeviceScopes(readFormValue(form, 'scope'))
	if (!scopes.ok) return oauthErrorResponse('invalid_scope', scopes.error)
	const canonicalResource = mcpOAuthResourceUri(appOrigin)
	const resource = readFormValue(form, 'resource') ?? canonicalResource
	if (resource !== canonicalResource) {
		return oauthErrorResponse(
			'invalid_target',
			`resource must be ${canonicalResource}.`,
		)
	}
	const orgInput = readFormValue(form, 'org')
	const requestedOrgSlug = orgInput ? normalizeOrgSlug(orgInput) || null : null

	const now = nowSeconds()
	await purgeExpiredDeviceAuthorizations(env.APP_DB, now)
	const deviceCode = generateDeviceCode()
	const deviceCodeHash = await hashDeviceCode(deviceCode)
	let userCode: string | null = null
	for (let attempt = 0; attempt < 5 && !userCode; attempt += 1) {
		const candidate = generateUserCode()
		const inserted = await insertDeviceAuthorization(env.APP_DB, {
			id: crypto.randomUUID(),
			device_code_hash: deviceCodeHash,
			user_code: candidate,
			client_id: clientId,
			scope: scopes.scopes.join(' '),
			resource,
			requested_org_slug: requestedOrgSlug,
			interval_seconds: devicePollIntervalSeconds,
			created_at: now,
			expires_at: now + deviceCodeTtlSeconds,
		})
		if (inserted) userCode = candidate
	}
	if (!userCode) {
		return oauthErrorResponse(
			'server_error',
			'Could not allocate a sign-in code. Try again.',
			503,
		)
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'oauth',
		action: 'device_authorization',
		result: 'success',
		ip,
		clientId,
	})
	const displayCode = formatUserCode(userCode)
	const verificationUri = new URL(oauthPaths.device, appOrigin)
	const verificationUriComplete = new URL(verificationUri)
	verificationUriComplete.searchParams.set('user_code', displayCode)
	return jsonResponse(
		{
			device_code: deviceCode,
			user_code: displayCode,
			verification_uri: verificationUri.href,
			verification_uri_complete: verificationUriComplete.href,
			expires_in: deviceCodeTtlSeconds,
			interval: devicePollIntervalSeconds,
		},
		{ headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } },
	)
}
