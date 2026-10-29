/**
 * Upstream revocation for an OAuth connection being wiped (ADR 0068
 * amendment 2026-10-29). GitHub OAuth Apps revoke through
 * `DELETE /applications/{client_id}/token`; providers with a known RFC 7009
 * revocation endpoint get a revoke request. Anything else is skipped and
 * reported as `unsupported`. Callers wipe locally whatever this returns; it
 * never throws and never logs a token.
 */

export type UpstreamRevokeOutcome =
	| 'revoked'
	| 'already_invalid'
	| 'unsupported'
	| 'no_token'
	| 'failed'

export type UpstreamRevokeResult = {
	outcome: UpstreamRevokeOutcome
	/** HTTP status from the provider, when a request was made. */
	status: number | null
}

export type UpstreamRevokeApp = {
	provider: string | null
	tokenUrl: string
	clientId: string
}

const revokeTimeoutMs = 10_000

/** RFC 7009 revocation endpoints for token hosts that publish one. */
const rfc7009RevocationUrls: Record<string, string> = {
	'oauth2.googleapis.com': 'https://oauth2.googleapis.com/revoke',
	'accounts.google.com': 'https://oauth2.googleapis.com/revoke',
}

function tokenHost(tokenUrl: string): string | null {
	try {
		return new URL(tokenUrl).hostname.toLowerCase()
	} catch {
		return null
	}
}

export function isGithubOauthApp(app: UpstreamRevokeApp): boolean {
	return (
		app.provider?.toLowerCase() === 'github' ||
		tokenHost(app.tokenUrl) === 'github.com'
	)
}

export function upstreamRevocationSupported(app: UpstreamRevokeApp): boolean {
	if (isGithubOauthApp(app)) return true
	const host = tokenHost(app.tokenUrl)
	return host != null && Object.hasOwn(rfc7009RevocationUrls, host)
}

function basicAuth(clientId: string, clientSecret: string) {
	return `Basic ${btoa(`${clientId}:${clientSecret}`)}`
}

async function revokeGithub(input: {
	app: UpstreamRevokeApp
	clientSecret: string
	accessToken: string
	fetchImpl: typeof fetch
}): Promise<UpstreamRevokeResult> {
	const response = await input.fetchImpl(
		`https://api.github.com/applications/${encodeURIComponent(input.app.clientId)}/token`,
		{
			method: 'DELETE',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: basicAuth(input.app.clientId, input.clientSecret),
				'Content-Type': 'application/json',
				'User-Agent': 'kody',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			body: JSON.stringify({ access_token: input.accessToken }),
			signal: AbortSignal.timeout(revokeTimeoutMs),
		},
	)
	await response.body?.cancel()
	if (response.status === 204) return { outcome: 'revoked', status: 204 }
	// 404: the token is already gone or does not belong to this app.
	if (response.status === 404) {
		return { outcome: 'already_invalid', status: 404 }
	}
	return { outcome: 'failed', status: response.status }
}

async function revokeRfc7009(input: {
	url: string
	app: UpstreamRevokeApp
	clientSecret: string | null
	token: string
	tokenTypeHint: 'access_token' | 'refresh_token'
	fetchImpl: typeof fetch
}): Promise<UpstreamRevokeResult> {
	const body = new URLSearchParams({
		token: input.token,
		token_type_hint: input.tokenTypeHint,
	})
	const headers: Record<string, string> = {
		'Content-Type': 'application/x-www-form-urlencoded',
		Accept: 'application/json',
	}
	if (input.clientSecret) {
		headers.Authorization = basicAuth(input.app.clientId, input.clientSecret)
	} else {
		body.set('client_id', input.app.clientId)
	}
	const response = await input.fetchImpl(input.url, {
		method: 'POST',
		headers,
		body,
		signal: AbortSignal.timeout(revokeTimeoutMs),
	})
	// RFC 7009 answers 200 for an invalid token; some providers send 400
	// invalid_token instead. Other 400s (invalid_request, ...) left it live.
	if (response.status === 400) {
		const error = await response
			.json()
			.then((body) =>
				body && typeof body === 'object' ? Reflect.get(body, 'error') : null,
			)
			.catch(() => null)
		return error === 'invalid_token'
			? { outcome: 'already_invalid', status: 400 }
			: { outcome: 'failed', status: 400 }
	}
	await response.body?.cancel()
	if (response.ok) return { outcome: 'revoked', status: response.status }
	return { outcome: 'failed', status: response.status }
}

export async function revokeOauthTokensUpstream(input: {
	app: UpstreamRevokeApp
	clientSecret: string | null
	accessToken: string | null
	refreshToken: string | null
	fetchImpl?: typeof fetch
}): Promise<UpstreamRevokeResult> {
	const fetchImpl = input.fetchImpl ?? fetch
	try {
		if (isGithubOauthApp(input.app)) {
			if (!input.accessToken) return { outcome: 'no_token', status: null }
			if (!input.clientSecret) return { outcome: 'unsupported', status: null }
			return await revokeGithub({
				app: input.app,
				clientSecret: input.clientSecret,
				accessToken: input.accessToken,
				fetchImpl,
			})
		}
		const host = tokenHost(input.app.tokenUrl)
		const url =
			host && Object.hasOwn(rfc7009RevocationUrls, host)
				? rfc7009RevocationUrls[host]
				: undefined
		if (!url) return { outcome: 'unsupported', status: null }
		// Revoking the refresh token ends the whole grant where supported.
		const token = input.refreshToken ?? input.accessToken
		if (!token) return { outcome: 'no_token', status: null }
		return await revokeRfc7009({
			url,
			app: input.app,
			clientSecret: input.clientSecret,
			token,
			tokenTypeHint: input.refreshToken ? 'refresh_token' : 'access_token',
			fetchImpl,
		})
	} catch {
		return { outcome: 'failed', status: null }
	}
}
