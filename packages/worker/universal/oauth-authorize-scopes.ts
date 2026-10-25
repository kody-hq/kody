import { uniqueOauthScopes } from '#universal/oauth-scopes.ts'

/**
 * Authorize / device hosts that reject requests with no `scope` parameter
 * (or equivalent). Values are safe minimal defaults used when a bring-your-own
 * connect has no query scopes and no stored connection scopes.
 *
 * Hosts omitted here keep today's "omit scope when empty" behavior (GitHub,
 * Notion, and other providers that accept a scopeless authorize request).
 */
const authorizeHostsRequiringScopes: Readonly<
	Record<string, ReadonlyArray<string>>
> = {
	'accounts.google.com': ['openid', 'email', 'profile'],
	'www.linkedin.com': ['openid', 'profile', 'email'],
	'linkedin.com': ['openid', 'profile', 'email'],
	'login.microsoftonline.com': ['openid', 'profile', 'email', 'offline_access'],
	'accounts.spotify.com': ['user-read-email'],
	'x.com': ['tweet.read', 'users.read', 'offline.access'],
	'twitter.com': ['tweet.read', 'users.read', 'offline.access'],
	'discord.com': ['identify', 'email'],
	'www.dropbox.com': [
		'account_info.read',
		'files.metadata.read',
		'files.content.read',
		'files.content.write',
	],
	'slack.com': [],
}

function normalizeAuthorizeHost(host: string | null | undefined): string {
	return (host ?? '').trim().toLowerCase()
}

/**
 * Prefer a host that requires scopes (authorize URL over device/token hosts
 * that share a provider family but are not in the require map).
 */
export function pickAuthorizeScopeHost(
	hosts: ReadonlyArray<string | null | undefined>,
): string | null {
	const normalized = hosts
		.map((host) => normalizeAuthorizeHost(host))
		.filter((host) => host.length > 0)
	for (const host of normalized) {
		if (host in authorizeHostsRequiringScopes) return host
	}
	return normalized[0] ?? null
}

export function authorizeHostRequiresScopes(
	host: string | null | undefined,
): boolean {
	const key = normalizeAuthorizeHost(host)
	return Boolean(key && key in authorizeHostsRequiringScopes)
}

export function defaultScopesForAuthorizeHost(
	host: string | null | undefined,
): Array<string> {
	const key = normalizeAuthorizeHost(host)
	if (!key) return []
	const defaults = authorizeHostsRequiringScopes[key]
	return defaults ? uniqueOauthScopes(defaults) : []
}

export function buildMissingAuthorizeScopesError(
	host: string | null | undefined,
): string {
	const normalized = normalizeAuthorizeHost(host) || 'this provider'
	return [
		`${normalized} requires OAuth scopes before connecting.`,
		'Add them with the scopes query parameter (see the provider setup guide),',
		'or ask your agent to set authorization.scopes on the connection, then try again.',
		'Kody will not redirect to the provider with an empty scope set.',
	].join(' ')
}

/**
 * Resolve the scope list for an authorize or device start request.
 *
 * Non-empty requested scopes always win. When empty and the host requires
 * scopes, optionally fill host defaults (`fillDefaults: true` for BYO
 * prefill). When still empty and the host requires scopes, return an error
 * instead of allowing a redirect that the provider will reject.
 */
export function resolveAuthorizeRequestScopes(input: {
	scopes: ReadonlyArray<string> | null | undefined
	authorizeHost: string | null | undefined
	/** When true, empty scopes become host defaults when the host has any. */
	fillDefaults: boolean
}):
	| { ok: true; scopes: Array<string>; filledFromDefaults: boolean }
	| { ok: false; error: string } {
	const requested = uniqueOauthScopes(input.scopes)
	if (requested.length > 0) {
		return { ok: true, scopes: requested, filledFromDefaults: false }
	}
	if (!authorizeHostRequiresScopes(input.authorizeHost)) {
		return { ok: true, scopes: [], filledFromDefaults: false }
	}
	if (input.fillDefaults) {
		const defaults = defaultScopesForAuthorizeHost(input.authorizeHost)
		if (defaults.length > 0) {
			return { ok: true, scopes: defaults, filledFromDefaults: true }
		}
	}
	return {
		ok: false,
		error: buildMissingAuthorizeScopesError(input.authorizeHost),
	}
}
