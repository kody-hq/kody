/**
 * Path prefixes that must keep serving directly on legacy hosts even after
 * redirects are enabled:
 *
 * - `/mcp`: MCP clients POST here and do not follow redirects; existing
 *   client configs keep pointing at the legacy host indefinitely.
 * - `/oauth` + `/.well-known`: OAuth metadata is origin-exact (RFC 8414 /
 *   RFC 9728), and the Tesla public key lives under
 *   `/.well-known/appspecific/`.
 * - `/auth` + `/webauthn`: social-login callbacks are registered per origin,
 *   and passkey `rpID` is the request hostname.
 * - `/connect/oauth`: integration OAuth callbacks registered on the legacy
 *   origin keep landing here.
 * - `/health`: the status page probes the legacy origin directly.
 * - `/__maintenance`: operator endpoints are invoked against a specific
 *   origin.
 * Permanent: saved MCP client configs keep pointing at legacy app hosts, so those hosts keep serving.
 */
const stickyPathPrefixes = [
	'/mcp',
	'/oauth',
	'/.well-known',
	'/auth',
	'/webauthn',
	'/connect/oauth',
	'/health',
	'/__maintenance',
]

function isStickyPath(pathname: string) {
	return stickyPathPrefixes.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	)
}

export function parseLegacyHosts(configured: string | null | undefined) {
	if (!configured) return []
	const hostnames: Array<string> = []
	for (const entry of configured.split(',')) {
		const hostname = entry.trim().toLowerCase().replace(/\.$/, '')
		if (hostname && !hostnames.includes(hostname)) hostnames.push(hostname)
	}
	return hostnames
}

/**
 * Redirect safe browser navigation from a legacy app host (for example
 * `legacy.example`) to the canonical origin (`APP_BASE_URL`) with a
 * path-and-query-preserving 308.
 *
 * Deliberately narrow: only GET/HEAD (a 308 preserves the method, and
 * redirected POSTs break MCP and webhook callers that never follow
 * redirects), only hosts listed in `APP_LEGACY_HOSTS`, never the sticky
 * protocol paths, and only when `APP_LEGACY_REDIRECT` is exactly `'true'` —
 * the first migration phase dual-serves both hosts with no redirects at all.
 *
 * Returns `null` when the request should be served normally.
 * Permanent: saved MCP client configs keep pointing at legacy app hosts, so those hosts keep serving.
 */
export function getLegacyHostRedirectResponse(input: {
	request: Request
	env: {
		APP_BASE_URL?: string | null
		APP_LEGACY_HOSTS?: string | null
		APP_LEGACY_REDIRECT?: string | null
	}
}): Response | null {
	// Exact 'true' like WRANGLER_IS_LOCAL_DEV: no other value may enable
	// redirects in a real deployment.
	if (input.env.APP_LEGACY_REDIRECT !== 'true') return null
	const method = input.request.method
	if (method !== 'GET' && method !== 'HEAD') return null

	const legacyHosts = parseLegacyHosts(input.env.APP_LEGACY_HOSTS)
	if (legacyHosts.length === 0) return null

	let url: URL
	try {
		url = new URL(input.request.url)
	} catch {
		return null
	}
	if (!legacyHosts.includes(url.hostname.toLowerCase())) return null
	if (isStickyPath(url.pathname)) return null

	// Only the configured canonical origin qualifies as a redirect target;
	// the request-origin-first getAppBaseUrl would redirect a legacy host to
	// itself.
	// Remove when: issue #3836 phase 3 enforces credential stamps on every package.
	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (!configuredBaseUrl) return null
	let canonical: URL
	try {
		canonical = new URL(configuredBaseUrl)
	} catch {
		return null
	}
	if (canonical.hostname.toLowerCase() === url.hostname.toLowerCase()) {
		return null
	}

	return Response.redirect(
		`${canonical.origin}${url.pathname}${url.search}`,
		308,
	)
}
