const cookieOriginPrefix = '# origin='
const cookieEmailPrefix = '# email='
const cookieOrgPrefix = '# org='
const oauthClientIdPrefix = '# oauth-client-id='
const oauthClientSecretPrefix = '# oauth-client-secret='
const oauthRedirectUriPrefix = '# oauth-redirect-uri='
const oauthAccessTokenPrefix = '# oauth-access-token='

export type AppSessionOAuth = {
	clientId: string
	clientSecret: string
	redirectUri: string
	accessToken: string
}

export type AppSessionFile = {
	origin: string
	email: string | null
	/** Organization the cached OAuth token was minted for. Null is unbound. */
	org: string | null
	cookieHeader: string | null
	oauth: AppSessionOAuth | null
}

export type McpAuthCache = {
	cookieHeader?: string
	oauth?: AppSessionOAuth
	orgSlug?: string
}

export function normalizeCookieOrigin(origin: string) {
	return origin.replace(/\/$/, '')
}

function normalizeCookieEmail(email: string) {
	return email.trim().toLowerCase()
}

/** Same shape as OAuth `?org=` (trim, lowercase, optional leading `@`). */
function normalizeCookieOrg(orgSlug: string) {
	const slug = orgSlug.trim().toLowerCase().replace(/^@/, '')
	return slug.length > 0 ? slug : null
}

export function formatCookieFile(
	origin: string,
	cookieHeader: string,
	email?: string | null,
	oauth?: AppSessionOAuth | null,
	orgSlug?: string | null,
) {
	const lines = [`${cookieOriginPrefix}${normalizeCookieOrigin(origin)}`]
	if (email) lines.push(`${cookieEmailPrefix}${normalizeCookieEmail(email)}`)
	const org = orgSlug ? normalizeCookieOrg(orgSlug) : null
	if (org) lines.push(`${cookieOrgPrefix}${org}`)
	if (oauth) {
		lines.push(`${oauthClientIdPrefix}${oauth.clientId}`)
		lines.push(`${oauthClientSecretPrefix}${oauth.clientSecret}`)
		lines.push(`${oauthRedirectUriPrefix}${oauth.redirectUri}`)
		lines.push(`${oauthAccessTokenPrefix}${oauth.accessToken}`)
	}
	return `${lines.join('\n')}\n${cookieHeader}\n`
}

function readPrefixedLine(line: string, prefix: string) {
	if (!line.startsWith(prefix)) return null
	const value = line.slice(prefix.length).trim()
	return value.length > 0 ? value : null
}

function parseCookieFile(fileText: string): AppSessionFile | null {
	const trimmed = fileText.trim()
	if (!trimmed) return null
	const lines = trimmed.split(/\r?\n/)
	const firstLine = lines[0] ?? ''
	if (!firstLine.startsWith(cookieOriginPrefix)) return null
	const origin = firstLine.slice(cookieOriginPrefix.length).trim()
	let email: string | null = null
	let org: string | null = null
	let clientId: string | null = null
	let clientSecret: string | null = null
	let redirectUri: string | null = null
	let accessToken: string | null = null
	const cookieLines: Array<string> = []
	for (const line of lines.slice(1)) {
		const nextEmail = readPrefixedLine(line, cookieEmailPrefix)
		if (nextEmail !== null) {
			email = normalizeCookieEmail(nextEmail)
			continue
		}
		const nextOrg = readPrefixedLine(line, cookieOrgPrefix)
		if (nextOrg !== null) {
			org = normalizeCookieOrg(nextOrg)
			continue
		}
		const nextClientId = readPrefixedLine(line, oauthClientIdPrefix)
		if (nextClientId !== null) {
			clientId = nextClientId
			continue
		}
		const nextClientSecret = readPrefixedLine(line, oauthClientSecretPrefix)
		if (nextClientSecret !== null) {
			clientSecret = nextClientSecret
			continue
		}
		const nextRedirectUri = readPrefixedLine(line, oauthRedirectUriPrefix)
		if (nextRedirectUri !== null) {
			redirectUri = nextRedirectUri
			continue
		}
		const nextAccessToken = readPrefixedLine(line, oauthAccessTokenPrefix)
		if (nextAccessToken !== null) {
			accessToken = nextAccessToken
			continue
		}
		if (line.startsWith('#')) continue
		cookieLines.push(line)
	}
	const cookieHeader = cookieLines.join('\n').trim()
	const oauth =
		clientId && clientSecret && redirectUri && accessToken
			? { clientId, clientSecret, redirectUri, accessToken }
			: null
	return {
		origin,
		email,
		org,
		cookieHeader: cookieHeader.length > 0 ? cookieHeader : null,
		oauth,
	}
}

/**
 * Session lookup. `orgSlug` omitted ignores the org binding (request and
 * browse only need the login cookie). `null` is the unbound MCP connection
 * (no `--org`). A string requires that exact org, so a token minted for
 * another org is not reused.
 */
export function sessionForOrigin(
	fileText: string,
	origin: string,
	email?: string | null,
	orgSlug?: string | null,
): AppSessionFile | null {
	const parsed = parseCookieFile(fileText)
	if (!parsed) return null
	if (parsed.origin !== normalizeCookieOrigin(origin)) return null
	if (email) {
		if (!parsed.email) return null
		if (parsed.email !== normalizeCookieEmail(email)) return null
	}
	if (orgSlug !== undefined && parsed.org !== requestedOrgSlug(orgSlug)) {
		return null
	}
	return parsed
}

function requestedOrgSlug(orgSlug: string | null) {
	if (orgSlug === null) return null
	return normalizeCookieOrg(orgSlug)
}

/**
 * Auth to pass to `connectAppMcpClient`. The login cookie is keyed by origin
 * and email, so an org switch keeps it. The bearer token is keyed by org:
 * a different `--org`, or dropping `--org`, omits `oauth` and the next call
 * remints. `orgSlug` is still returned so the new token binds to that org.
 */
export function mcpAuthForOrg(
	fileText: string | null,
	origin: string,
	email: string,
	orgSlug: string | null,
): McpAuthCache {
	const session = fileText ? sessionForOrigin(fileText, origin, email) : null
	const slug = orgSlug ? normalizeCookieOrg(orgSlug) : null
	const oauth = session?.org === slug ? session.oauth : null
	return {
		...(session?.cookieHeader ? { cookieHeader: session.cookieHeader } : {}),
		...(oauth ? { oauth } : {}),
		...(slug ? { orgSlug: slug } : {}),
	}
}

function looksLikeLoginHtml(rawBody: string) {
	for (const match of rawBody.matchAll(/<link\b[^>]*>/gi)) {
		const tag = match[0]
		if (!/\brel="canonical"/i.test(tag)) continue
		if (!/\bdata-kody-head="canonical"/i.test(tag)) continue
		const href = tag.match(/\bhref="([^"]+)"/i)?.[1]
		if (!href) continue
		try {
			return new URL(href, 'https://control-kody.invalid').pathname === '/login'
		} catch {
			return false
		}
	}
	return false
}

function locationPointsToLogin(
	location: string | null | undefined,
	requestOrigin?: string,
) {
	if (!location) return false
	try {
		const base = requestOrigin ?? 'https://control-kody.invalid'
		return new URL(location, base).pathname === '/login'
	} catch {
		return false
	}
}

export function shouldRefreshSession(input: {
	skipLogin: boolean
	status: number
	path: string
	rawBody: string
	method?: string
	/** Response Location (redirect:manual 302 to /login). */
	location?: string | null
}) {
	if (input.skipLogin) return false
	if (input.status === 401) return true
	if (input.path === '/login') return false
	const method = input.method?.toUpperCase()
	if (method === 'POST' && input.path === '/logout') return false
	if (
		(input.status === 302 || input.status === 303 || input.status === 307) &&
		locationPointsToLogin(input.location)
	) {
		return true
	}
	return looksLikeLoginHtml(input.rawBody)
}
