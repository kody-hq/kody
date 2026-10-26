import { AsyncLocalStorage } from 'node:async_hooks'
import { oauthPaths } from '#universal/oauth-paths.ts'
import { logAuditEvent } from '#worker/audit-log.ts'
import {
	cimdFetchFailureLabel,
	classifyCimdFetchError,
} from '#worker/oauth-cimd-last-known-good.ts'
import { normalizeCimdClientId } from '#worker/oauth-known-cimd-clients.ts'

/**
 * Mirrors `@cloudflare/workers-oauth-provider` `OAuthErrorInternal` without
 * importing that package (this module is reached from
 * `oauth-provider-options`, which must stay off the provider runtime path).
 */
export type OAuthProviderErrorInternal = {
	category: string
	reason: string
	detail?: unknown
}

const reportedInternalCategories = new Set([
	'refresh-token-grant',
	'authorization-code-grant',
	'token-exchange-grant',
])

const reportedErrorCodes = new Set([
	'invalid_grant',
	'invalid_token',
	'invalid_client',
])

export type OAuthProviderErrorReport = {
	code: string
	description: string
	status: number
	headers: Record<string, string>
	internal: OAuthProviderErrorInternal
	request?: Request
}

const cimdCategory = 'client-id-metadata-document'

function isTokenEndpointRequest(request: Request | undefined) {
	if (!request) return false
	try {
		return new URL(request.url).pathname === oauthPaths.token
	} catch {
		return false
	}
}

/**
 * Whether this provider error is a token/refresh failure worth recording.
 * CIMD metadata failures count only at the token endpoint (a refresh or code
 * exchange that failed because the client's document did not resolve);
 * authorize and `/mcp` lookups keep the provider's own warning. Skips routine
 * request-shape rejects and protected-resource `invalid_token` (common `/mcp`
 * bearer rejects that would flood logs/audit).
 */
export function shouldReportOAuthProviderError(
	error: Pick<OAuthProviderErrorReport, 'code' | 'internal' | 'request'>,
) {
	if (error.internal.category === cimdCategory) {
		return isTokenEndpointRequest(error.request)
	}
	if (
		error.code === 'invalid_token' &&
		error.internal.category === 'protected-resource'
	) {
		return false
	}
	if (reportedErrorCodes.has(error.code)) return true
	return reportedInternalCategories.has(error.internal.category)
}

/**
 * Build a log/audit reason that names the stable internal check without any
 * token material. Descriptions stay out of the audit reason (they can repeat
 * grant text); category+reason are the durable diagnostic.
 */
export function oauthProviderErrorAuditReason(
	error: Pick<OAuthProviderErrorReport, 'code' | 'internal'>,
) {
	return `${error.code}:${error.internal.category}:${error.internal.reason}`
}

/**
 * Best-effort client_id from Basic auth only (sync). Matches RFC 6749: the
 * credentials are form-urlencoded then joined with `:`, so URL-shaped client
 * ids use `%3A` for scheme colons and the first literal `:` separates the
 * secret. Never returns the password half. Form-body client_id needs an async
 * body read and is handled in {@link reportOAuthProviderError}.
 */
export function safeClientIdFromBasicAuthorization(
	authorizationHeader: string | null,
) {
	if (!authorizationHeader?.startsWith('Basic ')) return undefined
	try {
		const decoded = atob(authorizationHeader.slice('Basic '.length).trim())
		const colon = decoded.indexOf(':')
		if (colon === -1) return undefined
		const clientId = decodeURIComponent(
			decoded.slice(0, colon).replace(/\+/g, ' '),
		).trim()
		if (!clientId || clientId.length > 2048) return undefined
		return clientId
	} catch {
		return undefined
	}
}

/**
 * Public client_id of the token request being handled, set by
 * `handleMcpOAuthTokenRequest` before the provider reads the body. The
 * provider reports refresh and code grant failures to `onError` without the
 * request (and a consumed body cannot be cloned), so without this every
 * reported token error lacked its client id. `onError` starts the report
 * synchronously inside the provider call, so the store is still set.
 */
const tokenRequestClientId = new AsyncLocalStorage<string | null>()

export function runWithTokenRequestClientId<Result>(
	clientId: string | null | undefined,
	run: () => Result,
): Result {
	const trimmed = clientId?.trim()
	return tokenRequestClientId.run(
		trimmed && trimmed.length <= 2048 ? trimmed : null,
		run,
	)
}

async function safeClientIdFromRequest(request: Request | undefined) {
	if (!request) return undefined
	const fromBasic = safeClientIdFromBasicAuthorization(
		request.headers.get('Authorization'),
	)
	if (fromBasic) return fromBasic
	try {
		const contentType = request.headers.get('Content-Type') ?? ''
		if (!contentType.includes('application/x-www-form-urlencoded')) {
			return undefined
		}
		if (request.bodyUsed) return undefined
		const clone = request.clone()
		const body = await clone.text()
		const params = new URLSearchParams(body)
		const clientId = params.get('client_id')?.trim()
		if (!clientId || clientId.length > 2048) return undefined
		// Never read client_secret, refresh_token, code, or assertion fields.
		return clientId
	} catch {
		return undefined
	}
}

/**
 * CIMD failures carry the metadata URL (the public client id) and the
 * provider's fetch/validation message in `internal.detail`. Read only those
 * two fields, bounded, so the log names the client and why it failed.
 */
function cimdFailureDetail(internal: OAuthProviderErrorInternal) {
	if (internal.category !== cimdCategory) return {}
	const detail = internal.detail
	if (typeof detail !== 'object' || detail === null) return {}
	const { metadataUrl, message } = detail as {
		metadataUrl?: unknown
		message?: unknown
	}
	const clientId =
		typeof metadataUrl === 'string' && metadataUrl.length <= 2048
			? metadataUrl
			: undefined
	const normalized = clientId ? normalizeCimdClientId(clientId) : undefined
	return {
		...(clientId ? { clientId } : {}),
		...(normalized
			? { cimdHost: normalized.host, cimdPath: normalized.path }
			: {}),
		...(typeof message === 'string'
			? {
					cimdFailure: message.slice(0, 200),
					cimdError: cimdFetchFailureLabel(
						classifyCimdFetchError(new Error(message)),
					),
				}
			: {}),
	}
}

/** Dedupe: one report per request (the provider may report twice). */
const reportedRequests = new WeakSet<Request>()

/**
 * Record token/refresh failures with code + internal reason (+ client id when
 * available). Uses the audit-event console.info path; never logs token values,
 * secrets, emails, or `internal.detail` beyond the CIMD URL and message.
 */
export async function reportOAuthProviderError(
	error: OAuthProviderErrorReport,
) {
	if (!shouldReportOAuthProviderError(error)) return
	// Read before any await: the store belongs to the token request.
	const contextClientId = tokenRequestClientId.getStore() ?? undefined
	if (error.request) {
		if (reportedRequests.has(error.request)) return
		reportedRequests.add(error.request)
	}

	const cimd = cimdFailureDetail(error.internal)
	const clientId =
		cimd.clientId ??
		contextClientId ??
		(await safeClientIdFromRequest(error.request))
	// CIMD failures: `invalid_client:cimd:http_404` (stable, groupable).
	const reason =
		error.internal.category === cimdCategory && cimd.cimdError
			? `${error.code}:cimd:${cimd.cimdError}`
			: oauthProviderErrorAuditReason(error)
	const path = error.request ? new URL(error.request.url).pathname : undefined

	console.info(
		'oauth-provider-error',
		JSON.stringify({
			code: error.code,
			status: error.status,
			category: error.internal.category,
			reason: error.internal.reason,
			...(clientId ? { clientId } : {}),
			...(path ? { path } : {}),
			...(cimd.cimdHost ? { cimdHost: cimd.cimdHost } : {}),
			...(cimd.cimdPath ? { cimdPath: cimd.cimdPath } : {}),
			...(cimd.cimdError ? { cimdError: cimd.cimdError } : {}),
			...(cimd.cimdFailure ? { cimdFailure: cimd.cimdFailure } : {}),
		}),
	)

	await logAuditEvent({
		db: undefined,
		category: 'oauth',
		action: 'token_error',
		result: 'failure',
		clientId,
		path,
		reason,
	})
}
