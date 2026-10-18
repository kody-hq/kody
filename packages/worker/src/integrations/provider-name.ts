import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import { getDomain } from 'tldts'

/**
 * Integration identity metadata used to separate a provider slug from an
 * account-specific connection label (e.g. `google` from `google-business`).
 */
export type IntegrationProviderMetadata = {
	name: string
	tokenUrl: string
	apiBaseUrl?: string | null
	requiredHosts?: Array<string>
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
	} | null
}

const providerDomainAliases: Readonly<Record<string, string>> = {
	googleapis: 'google',
}

const providerTokenPattern = /[a-z0-9]+/g

function tokenizeProviderLabel(text: string): Array<string> {
	return (
		text
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/[_./:-]+/g, ' ')
			.toLowerCase()
			.match(providerTokenPattern) ?? []
	)
}

function providerMetadataHosts(
	integration: IntegrationProviderMetadata,
): Array<string> {
	const urls = [
		integration.tokenUrl,
		integration.apiBaseUrl,
		integration.authorization?.authorizeUrl,
	]
	const hosts = urls.flatMap((url) => {
		if (!url) return []
		try {
			return [new URL(url).hostname]
		} catch {
			return []
		}
	})
	return [...hosts, ...(integration.requiredHosts ?? [])]
}

function normalizeProviderDomainLabel(label: string): string {
	return providerDomainAliases[label] ?? label
}

function providerTokensFromHost(host: string): Array<string> {
	const registrableDomain = getDomain(host) ?? host.toLowerCase()
	const providerLabel = registrableDomain.split('.')[0] ?? registrableDomain
	return tokenizeProviderLabel(normalizeProviderDomainLabel(providerLabel))
}

/**
 * Separate the provider identity from an account-specific integration label.
 * A prefix is accepted only when saved endpoint metadata independently
 * identifies every token, so an arbitrary first segment is never assumed to be
 * the provider. The full integration name is the safe fallback.
 */
export function resolveIntegrationProviderName(
	integration: IntegrationProviderMetadata,
): string {
	const integrationName = normalizeProviderKey(integration.name)
	const nameSegments = integrationName.split('-').filter(Boolean)
	const providerTokenGroups = providerMetadataHosts(integration)
		.map(providerTokensFromHost)
		.filter((tokens) => tokens.length > 0)

	const matchesProviderTokens = (tokens: Array<string>) =>
		providerTokenGroups.some(
			(providerTokens) =>
				providerTokens.length === tokens.length &&
				providerTokens.every((token, index) => token === tokens[index]),
		)

	for (let length = nameSegments.length; length > 0; length--) {
		const prefix = nameSegments.slice(0, length).join('-')
		if (matchesProviderTokens(tokenizeProviderLabel(prefix))) {
			return prefix
		}
	}
	return integrationName
}
