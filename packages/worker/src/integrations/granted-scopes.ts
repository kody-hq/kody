/**
 * The scopes a provider actually granted on a token, as opposed to the
 * scopes a connection requested. Users can grant fewer scopes than requested
 * and a provider can keep scopes a narrower request left out, so Kody reads
 * the grant back after every connect instead of trusting the request.
 *
 * GitHub reports the grant on any API response in `X-OAuth-Scopes`, which is
 * the authoritative check for one token. Other providers fall back to the
 * RFC 6749 token-response `scope` field when present; otherwise the grant is
 * unknown. Nothing here revokes a token or an app authorization.
 */
import { isGithubOauthApp } from '#worker/integrations/upstream-revoke.ts'

export const grantedScopesSourceValues = [
	'github-x-oauth-scopes',
	'token-response',
] as const

export type GrantedScopesSource = (typeof grantedScopesSourceValues)[number]

export type GrantedScopes = {
	scopes: Array<string>
	source: GrantedScopesSource
	checkedAt: string
}

export type ScopeGrantComparison = {
	/** Requested but not granted (the user or provider narrowed the grant). */
	missing: Array<string>
	/** Granted but not requested (a narrower request did not shrink the token). */
	extra: Array<string>
}

export function parseScopeList(value: unknown): Array<string> | null {
	const raw =
		typeof value === 'string'
			? value.split(/[\s,]+/)
			: Array.isArray(value)
				? value.filter((entry): entry is string => typeof entry === 'string')
				: null
	if (!raw) return null
	return Array.from(
		new Set(raw.map((scope) => scope.trim()).filter(Boolean)),
	).sort()
}

export function compareRequestedAndGrantedScopes(
	requested: ReadonlyArray<string>,
	granted: ReadonlyArray<string>,
): ScopeGrantComparison {
	const requestedSet = new Set(requested.map((scope) => scope.trim()))
	const grantedSet = new Set(granted.map((scope) => scope.trim()))
	return {
		missing: [...requestedSet].filter(
			(scope) => scope && !grantedSet.has(scope),
		),
		extra: [...grantedSet].filter((scope) => scope && !requestedSet.has(scope)),
	}
}

const githubScopeCheckTimeoutMs = 10_000

async function readGithubTokenScopes(input: {
	accessToken: string
	fetchImpl: typeof fetch
}): Promise<Array<string> | null> {
	try {
		const response = await input.fetchImpl('https://api.github.com/user', {
			method: 'GET',
			headers: {
				Accept: 'application/vnd.github+json',
				Authorization: `Bearer ${input.accessToken}`,
				'User-Agent': 'kody',
				'X-GitHub-Api-Version': '2022-11-28',
			},
			signal: AbortSignal.timeout(githubScopeCheckTimeoutMs),
		})
		const header = response.headers.get('x-oauth-scopes')
		if (!response.ok || header == null) return null
		return parseScopeList(header) ?? []
	} catch {
		return null
	}
}

export async function readGrantedScopes(input: {
	app: { provider: string | null; tokenUrl: string }
	accessToken: string
	tokenRecord: Record<string, unknown>
	fetchImpl?: typeof fetch
	now?: () => Date
}): Promise<GrantedScopes | null> {
	const checkedAt = (input.now?.() ?? new Date()).toISOString()
	if (isGithubOauthApp({ ...input.app, clientId: '' })) {
		const scopes = await readGithubTokenScopes({
			accessToken: input.accessToken,
			fetchImpl: input.fetchImpl ?? fetch,
		})
		if (scopes) {
			return { scopes, source: 'github-x-oauth-scopes', checkedAt }
		}
	}
	const fromResponse = parseScopeList(input.tokenRecord.scope)
	if (!fromResponse) return null
	return { scopes: fromResponse, source: 'token-response', checkedAt }
}
