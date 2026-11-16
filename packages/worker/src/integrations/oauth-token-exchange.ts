import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'

/**
 * Outbound integration token-exchange request styles for `/connect/oauth`.
 *
 * - `form`: application/x-www-form-urlencoded body; confidential clients put
 *   `client_secret` in the body (GitHub/Slack-style).
 * - `basic-json`: HTTP Basic (client_id:client_secret) + JSON body without
 *   credentials in the body (Notion-style).
 * - `basic-form`: HTTP Basic (client_id:client_secret) +
 *   application/x-www-form-urlencoded body without credentials in the body
 *   (Canva-style).
 *
 * Client-secret authentication and PKCE are orthogonal: `params` may carry a
 * PKCE `code_verifier` in any style, so providers like Canva that require both
 * S256 PKCE and a client secret on token exchange are supported.
 */
export const tokenExchangeStyles = ['form', 'basic-json', 'basic-form'] as const
export type TokenExchangeStyle = (typeof tokenExchangeStyles)[number]

export function isTokenExchangeStyle(
	value: string,
): value is TokenExchangeStyle {
	return (tokenExchangeStyles as ReadonlyArray<string>).includes(value)
}

export function resolveTokenExchangeStyle(input: {
	tokenUrl: string
	tokenExchangeStyle?: string | null
}): TokenExchangeStyle {
	const explicit = input.tokenExchangeStyle?.trim()
	if (explicit && isTokenExchangeStyle(explicit)) return explicit
	const host = safeParseHost(input.tokenUrl)
	// Notion's token endpoint rejects form-body client_secret and requires
	// Basic Auth + JSON: https://developers.notion.com/guides/get-started/authorization
	if (host === 'api.notion.com') return 'basic-json'
	// Canva's token endpoint takes Basic Auth (or form-body credentials) with
	// an urlencoded body: https://www.canva.dev/docs/connect/authentication/
	if (host === 'api.canva.com') return 'basic-form'
	return 'form'
}

export function buildOAuthTokenExchangeRequest(input: {
	params: URLSearchParams
	flow: 'pkce' | 'confidential'
	clientSecret: string | null
	style: TokenExchangeStyle
}): { headers: Record<string, string>; body: string } {
	const params = new URLSearchParams(input.params)
	switch (input.style) {
		case 'basic-json': {
			const authorization = buildBasicAuthorization({
				params,
				flow: input.flow,
				clientSecret: input.clientSecret,
				style: input.style,
			})
			const bodyObject = Object.fromEntries(params.entries())
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					Authorization: authorization,
				},
				body: JSON.stringify(bodyObject),
			}
		}
		case 'basic-form': {
			const authorization = buildBasicAuthorization({
				params,
				flow: input.flow,
				clientSecret: input.clientSecret,
				style: input.style,
			})
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
					Authorization: authorization,
				},
				body: params.toString(),
			}
		}
		case 'form': {
			if (input.flow === 'confidential') {
				if (!input.clientSecret) {
					throw new Error('Confidential flow requires a client secret.')
				}
				params.set('client_secret', input.clientSecret)
			}
			return {
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: params.toString(),
			}
		}
		default: {
			const exhaustiveCheck: never = input.style
			throw new Error(
				`Unhandled token exchange style: ${String(exhaustiveCheck)}`,
			)
		}
	}
}

/**
 * Builds the HTTP Basic Authorization header for the basic-* styles and strips
 * the credentials from the body params. Mutates `params`.
 */
function buildBasicAuthorization(input: {
	params: URLSearchParams
	flow: 'pkce' | 'confidential'
	clientSecret: string | null
	style: TokenExchangeStyle
}): string {
	if (input.flow !== 'confidential' || !input.clientSecret) {
		throw new Error(
			`${input.style} token exchange requires confidential flow with a client secret.`,
		)
	}
	const clientId = input.params.get('client_id')?.trim() ?? ''
	if (!clientId) {
		throw new Error(
			`${input.style} token exchange requires client_id in params.`,
		)
	}
	input.params.delete('client_id')
	input.params.delete('client_secret')
	return `Basic ${bytesToBase64(
		new TextEncoder().encode(
			`${formUrlEncodeBasicCredential(clientId)}:${formUrlEncodeBasicCredential(
				input.clientSecret,
			)}`,
		),
	)}`
}

/**
 * RFC 6749 §2.3.1: Basic-auth client credentials are
 * application/x-www-form-urlencoded before being joined with ":" and
 * base64-encoded, so ids or secrets containing ":" or "%" survive intact.
 * A no-op for the alphanumeric credentials real providers issue.
 */
function formUrlEncodeBasicCredential(value: string) {
	return encodeURIComponent(value).replace(/%20/g, '+')
}

const hoistedAuthedUserFields = [
	'access_token',
	'refresh_token',
	'expires_in',
	'token_type',
	'scope',
] as const

/**
 * Normalizes provider-specific success payload shapes to the standard OAuth
 * top-level fields. Slack's `oauth.v2.access` nests user tokens under
 * `authed_user` (top-level `access_token` is the bot token, absent for
 * user-scope-only apps); hoisting the nested fields keeps token persistence
 * provider-agnostic. Present top-level fields are never overwritten.
 */
export function normalizeOAuthTokenExchangePayload(
	payload: Record<string, unknown>,
): Record<string, unknown> {
	const topLevelToken = payload.access_token
	if (typeof topLevelToken === 'string' && topLevelToken.trim()) {
		return payload
	}
	const authedUser = payload.authed_user
	if (
		!authedUser ||
		typeof authedUser !== 'object' ||
		Array.isArray(authedUser)
	) {
		return payload
	}
	const nested = authedUser as Record<string, unknown>
	const nestedToken = nested.access_token
	if (typeof nestedToken !== 'string' || !nestedToken.trim()) {
		return payload
	}
	const hoisted: Record<string, unknown> = { ...payload }
	for (const field of hoistedAuthedUserFields) {
		if (hoisted[field] === undefined && nested[field] !== undefined) {
			hoisted[field] = nested[field]
		}
	}
	return hoisted
}

/**
 * Providers report token-endpoint failures with HTTP 200 in two shapes:
 * Slack sends `{ ok: false, error }` and GitHub sends `{ error }`, so a status
 * check alone misses them.
 */
export function isOAuthTokenExchangeSoftFailure(
	payload: Record<string, unknown>,
): boolean {
	if (payload.ok === false) return true
	return (
		readTrimmedString(payload.error) !== null &&
		readTrimmedString(
			normalizeOAuthTokenExchangePayload(payload).access_token,
		) === null
	)
}

/**
 * Provider token-endpoint failures must not reuse HTTP 401 — the connect UI
 * treats 401 from `/account/secrets.json` as an expired Kody session.
 */
export function oauthTokenExchangeFailureHttpStatus(): number {
	return 502
}

const providerErrorCodeMaxLength = 100
const providerErrorDescriptionMaxLength = 300

function readTrimmedString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Replace anything this request sent as a credential, in case a provider echoes it back. */
function redactSentCredentials(
	text: string | null,
	sentCredentials: ReadonlyArray<string | null | undefined>,
): string | null {
	if (!text) return text
	let redacted = text
	for (const credential of sentCredentials) {
		if (credential) redacted = redacted.replaceAll(credential, '[redacted]')
	}
	return redacted
}

/**
 * `error` is the message the connect page shows, so it carries the provider's
 * own reason. Without one it names the HTTP status and whether the body was
 * JSON, which is all that is known. The provider's raw body is never echoed,
 * and `sentCredentials` (client secret, authorization code, PKCE verifier) are
 * removed from the reason because it is also logged.
 */
export function buildOAuthTokenExchangeFailurePayload(input: {
	providerStatus: number
	payload: Record<string, unknown> | null
	sentCredentials: ReadonlyArray<string | null | undefined>
}): {
	ok: false
	error: string
	providerError?: string
	error_description?: string
	providerStatus: number
} {
	const providerError =
		redactSentCredentials(
			readTrimmedString(input.payload?.error),
			input.sentCredentials,
		)?.slice(0, providerErrorCodeMaxLength) ?? null
	const errorDescription =
		redactSentCredentials(
			readTrimmedString(input.payload?.error_description),
			input.sentCredentials,
		)?.slice(0, providerErrorDescriptionMaxLength) ?? null
	const reason =
		providerError && errorDescription
			? `${providerError} (${errorDescription})`
			: (providerError ??
				errorDescription ??
				`the provider returned HTTP ${input.providerStatus} with ${
					input.payload ? 'no error reason' : 'a response that was not JSON'
				}`)
	return {
		ok: false,
		error: `Token exchange failed: ${reason}`,
		...(providerError ? { providerError } : {}),
		...(errorDescription ? { error_description: errorDescription } : {}),
		providerStatus: input.providerStatus,
	}
}
