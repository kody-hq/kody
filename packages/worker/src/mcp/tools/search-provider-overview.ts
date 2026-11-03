import type { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'

import type { SearchMatch } from './search-format-types.ts'
import {
	buildMcpServerSearchMatch,
	listSynthesizedMcpServers,
	queryMatchesSynthesizedMcpServer,
} from './search-mcp-servers.ts'
import type { SearchCandidate } from './search-types.ts'

export function queryMatchesSynthesizedProvider(input: {
	query: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}) {
	return queryMatchesSynthesizedMcpServer(input)
}

/**
 * Unscoped search ranks MCP servers, not their individual tools. Drop any
 * leaked tool capabilities and emit the server card once if it is missing.
 */
export function collapseSynthesizedProviderMatches(input: {
	query: string
	candidates: Array<SearchCandidate>
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}): Array<SearchMatch> {
	const serversByKey = new Map(
		listSynthesizedMcpServers(input.registry).map((server) => [
			server.key,
			server,
		]),
	)
	const existingServerKeys = new Set(
		input.candidates.flatMap((candidate) =>
			candidate.type === 'mcp-server' && candidate.synthesizedProviderKey
				? [candidate.synthesizedProviderKey]
				: [],
		),
	)
	const emittedCards = new Set<string>()
	const matches: Array<SearchMatch> = []
	for (const candidate of input.candidates) {
		const server = candidate.synthesizedProviderKey
			? serversByKey.get(candidate.synthesizedProviderKey)
			: undefined
		if (!server || candidate.type !== 'capability') {
			matches.push(candidate.match)
			continue
		}
		if (existingServerKeys.has(server.key) || emittedCards.has(server.key)) {
			continue
		}
		matches.push(buildMcpServerSearchMatch({ server }))
		emittedCards.add(server.key)
	}
	return matches
}
