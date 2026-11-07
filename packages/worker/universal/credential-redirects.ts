/**
 * Old credential URLs and where they now live (contract: "Redirects"). Only
 * index pages move; approval and OAuth flows under them keep serving, and
 * `/connect/oauth` never moves because it is a registered OAuth redirect URI.
 * Secret providers keep their page: it is where package access to a vault is
 * granted and revoked, and the Credentials list links to it. Integrations
 * keeps its page too: it is the catalog of services you can connect, which
 * the Credentials list (your connections) does not show.
 */
import {
	credentialCreatePath,
	type CredentialKind,
} from './credential-contracts.ts'

const orgIndexRedirects: Record<string, CredentialKind> = {
	secrets: 'secret',
	'mcp-servers': 'mcp',
}

const orgIndexPattern = /^\/@([^/]+)\/-\/([^/]+)\/?$/

function withSearch(path: string, search: URLSearchParams) {
	const query = search.toString()
	return query ? `${path}?${query}` : path
}

/**
 * Secrets index links the Credentials list cannot serve: an approval request
 * (names with hosts or a package to grant) and a list narrowed to one
 * package's keys. Those keep the legacy page.
 */
const secretsIndexOnlyParams = [
	'hosts',
	'host',
	'allowed-host',
	'allowedHosts',
	'package_id',
	'capability',
	'package',
]

/**
 * The Secrets list filtered with `scope=user|package`; the Credentials list
 * calls that `packageScoped`. `user` meant the org's own keys, so a team org
 * leaves out personal keys granted to it.
 */
function translateSecretsListFilters(search: URLSearchParams) {
	const scope = search.get('scope')
	search.delete('scope')
	if (scope === 'package') search.set('packageScoped', 'true')
	if (scope === 'user') {
		search.set('scope', 'org')
		search.set('packageScoped', 'false')
	}
}

function orgIndexRedirect(url: URL): string | null {
	const match = orgIndexPattern.exec(url.pathname)
	if (!match) return null
	const [, orgSegment, section] = match
	if (!section || !Object.hasOwn(orgIndexRedirects, section)) return null
	// The MCP OAuth callback lands here with its result for the page banner.
	if (section === 'mcp-servers' && url.searchParams.has('auth')) return null
	if (
		section === 'secrets' &&
		secretsIndexOnlyParams.some((name) => url.searchParams.has(name))
	) {
		return null
	}
	const search = new URLSearchParams(url.searchParams)
	search.set('kind', orgIndexRedirects[section]!)
	if (section === 'secrets') translateSecretsListFilters(search)
	return withSearch(`/@${orgSegment}/-/credentials`, search)
}

const secretSetParamRenames: Record<string, string> = {
	'allowed-host': 'allowedHosts',
	// The creation link reserves `forPackage` for the package a need belongs
	// to; on `/connect/secret-set` these name packages the Key is locked to.
	package: 'allowedPackages',
	package_id: 'allowedPackages',
}

/**
 * `/connect/secret-set` (the legacy intake, deprecated) opens the Key form
 * with the same prefill: name, description, provider, hosts, expiry, package
 * scope (`scope`, `packageId`), and package locks.
 */
function connectSecretSetRedirect(url: URL): string {
	const search = new URLSearchParams()
	search.set('kind', 'secret')
	for (const [name, value] of url.searchParams) {
		if (name === 'kind') continue
		search.append(secretSetParamRenames[name] ?? name, value)
	}
	return withSearch(credentialCreatePath, search)
}

/** The new path and query for an old credential URL, or null to keep serving. */
export function credentialRedirectFor(url: URL): string | null {
	if (url.pathname === '/connect/secret-set') {
		return connectSecretSetRedirect(url)
	}
	return orgIndexRedirect(url)
}
