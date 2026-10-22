import { logAuditEvent } from '#worker/audit-log.ts'

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

/**
 * Whether this provider error is a token/refresh failure worth recording.
 * Skips CIMD metadata noise (already warned by the provider) and routine
 * request-shape rejects.
 */
export function shouldReportOAuthProviderError(
	error: Pick<OAuthProviderErrorReport, 'code' | 'internal'>,
) {
	if (error.internal.category === 'client-id-metadata-document') return false
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
 * Record token/refresh failures with code + internal reason (+ client id when
 * available). Uses the audit-event console.info path; never logs token values,
 * secrets, emails, or `internal.detail`.
 */
export async function reportOAuthProviderError(
	error: OAuthProviderErrorReport,
) {
	if (!shouldReportOAuthProviderError(error)) return

	const clientId = await safeClientIdFromRequest(error.request)
	const reason = oauthProviderErrorAuditReason(error)
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
		}),
	)

	void logAuditEvent({
		db: undefined,
		category: 'oauth',
		action: 'token_error',
		result: 'failure',
		clientId,
		path,
		reason,
	})
}
