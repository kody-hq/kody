import { getDomain } from 'tldts'

/**
 * Authorization server metadata checks for MCP OAuth (kody-hq/kody#3284,
 * parity with kody-celld#53 / #60).
 *
 * - RFC 8414 §3.3: the metadata `issuer` must equal the authorization server
 *   URL discovery used (trailing slash tolerated, as the MCP SDK's
 *   `issuersMatch` does). SDK 1.32.1 deliberately skips this check.
 * - The issuer, `authorization_endpoint` and `token_endpoint` must be https.
 *   Both endpoints must be on the issuer's origin or share its registrable
 *   domain (Public Suffix List, private entries included, so tenants of
 *   github.io or workers.dev never count as one site). A host with no
 *   registrable domain (IP, localhost, bare suffix) needs the exact origin.
 *   Datadog, Slack and Figma split endpoints across sibling hosts; splits
 *   across registrable domains (Google's accounts.google.com issuer with an
 *   oauth2.googleapis.com token endpoint) stay refused.
 *
 * `registration_endpoint` is out of scope.
 */

export type McpOAuthDiscoveryForIssuerEndpoints = {
	authorizationServerUrl?: unknown
	authorizationServerMetadata?: unknown
}

export const mcpOAuthFailedCode = 'mcp_oauth_failed'

export class McpOAuthFailedError extends Error {
	readonly code = mcpOAuthFailedCode
	readonly status = 502

	constructor(message: string) {
		super(`${mcpOAuthFailedCode}: ${message}`)
		this.name = 'McpOAuthFailedError'
	}
}

function registrableDomain(hostname: string) {
	return getDomain(hostname.toLowerCase(), { allowPrivateDomains: true })
}

/** Same origin, or both hosts share one non-null registrable domain. */
function endpointSharesIssuerSite(issuerUrl: URL, endpointUrl: URL) {
	if (endpointUrl.origin === issuerUrl.origin) return true
	const issuerDomain = registrableDomain(issuerUrl.hostname)
	const endpointDomain = registrableDomain(endpointUrl.hostname)
	return issuerDomain !== null && issuerDomain === endpointDomain
}

export function assertEndpointsOnIssuerOrigin(
	discovery: McpOAuthDiscoveryForIssuerEndpoints,
) {
	const metadata = discovery.authorizationServerMetadata
	if (!metadata || typeof metadata !== 'object') return
	const record = metadata as Record<string, unknown>
	const issuer = record['issuer']
	if (typeof issuer !== 'string' || !issuer) {
		throw new McpOAuthFailedError(
			'Authorization server metadata is missing a usable issuer.',
		)
	}

	let issuerUrl: URL
	try {
		issuerUrl = new URL(issuer)
	} catch {
		throw new McpOAuthFailedError(
			`Authorization server issuer (${issuer.slice(0, 200)}) is not a valid URL.`,
		)
	}
	if (issuerUrl.protocol !== 'https:') {
		throw new McpOAuthFailedError(
			`Authorization server issuer must use https (got ${issuerUrl.protocol}).`,
		)
	}

	for (const field of ['authorization_endpoint', 'token_endpoint'] as const) {
		const value = record[field]
		if (typeof value !== 'string' || !value) continue
		let endpointUrl: URL | null = null
		try {
			endpointUrl = new URL(value)
		} catch {
			/* refused below */
		}
		if (
			endpointUrl == null ||
			endpointUrl.protocol !== 'https:' ||
			!endpointSharesIssuerSite(issuerUrl, endpointUrl)
		) {
			throw new McpOAuthFailedError(
				`Authorization server ${field} (${endpointUrl?.origin ?? value.slice(0, 200)}) is not on its issuer's origin or registrable domain (${issuerUrl.origin}).`,
			)
		}
	}
}

/** The MCP SDK's `issuersMatch`: parsed URLs compared, one trailing slash tolerated. */
function issuersMatch(a: string, b: string) {
	let [x, y] = [a, b]
	try {
		;[x, y] = [new URL(a).href, new URL(b).href]
	} catch {
		// Not two URLs: compared as written.
	}
	return (
		x === y ||
		(x.endsWith('/') && x.slice(0, -1) === y) ||
		(y.endsWith('/') && y.slice(0, -1) === x)
	)
}

/** RFC 8414 §3.3: metadata `issuer` must echo the URL discovery fetched it for. */
export function assertIssuerMatchesAuthorizationServerUrl(
	discovery: McpOAuthDiscoveryForIssuerEndpoints,
) {
	const metadata = discovery.authorizationServerMetadata
	if (!metadata || typeof metadata !== 'object') return
	const issuer = (metadata as Record<string, unknown>)['issuer']
	if (typeof issuer !== 'string' || !issuer) {
		throw new McpOAuthFailedError(
			'Authorization server metadata is missing a usable issuer.',
		)
	}
	const serverUrl = discovery.authorizationServerUrl
	if (typeof serverUrl !== 'string' || !serverUrl) {
		throw new McpOAuthFailedError(
			'Authorization server discovery is missing the URL its metadata was fetched for.',
		)
	}
	if (!issuersMatch(issuer, serverUrl)) {
		throw new McpOAuthFailedError(
			`Authorization server issuer (${issuer.slice(0, 200)}) does not match the discovered authorization server (${serverUrl.slice(0, 200)}).`,
		)
	}
}

/** Every discovery write and read: endpoint site rule, then issuer echo. */
export function assertTrustedMcpOAuthDiscovery(
	discovery: McpOAuthDiscoveryForIssuerEndpoints,
) {
	assertEndpointsOnIssuerOrigin(discovery)
	assertIssuerMatchesAuthorizationServerUrl(discovery)
}
