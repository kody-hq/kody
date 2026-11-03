import type { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import type { CapabilitySpec } from '#mcp/capabilities/types.ts'
import { buildKodyCapabilityAccessor } from '#mcp/kody-capability-accessors.ts'

import { buildEntityRef } from './search-format-helpers.ts'
import type { SearchMatch } from './search-format-types.ts'
import type { PackageSearchRow } from './search-types.ts'
import { extractSearchTokens } from './understand-search-query.ts'

export type SynthesizedMcpServer = {
	key: string
	serverId: string
	serverName: string
	kodyName: string
	domain: string
	description: string
	instructions: string | null
	specs: Array<CapabilitySpec>
	identityFields: Array<string>
	operationIdentityFields: Array<string>
	usage: string
}

export type McpServerWrappingPackage = {
	kodyId: string
	name: string
	entityRef: string
}

export type McpServerToolIndexEntry = {
	name: string
	entityRef: string
	description: string
	toolName: string
	usage: string
}

const fallbackDomainDescription = (serverName: string) =>
	`Capabilities discovered from the connected MCP server "${serverName}".`

export function mcpServerEntityRef(kodyName: string) {
	return buildEntityRef(kodyName, 'mcp-server')
}

export function mcpServerUsage(kodyName: string) {
	return `kody.mcp[${JSON.stringify(kodyName)}].tool_name(args)`
}

export function listSynthesizedMcpServers(
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>,
): Array<SynthesizedMcpServer> {
	const domainsByName = new Map(
		(registry.capabilityDomains ?? []).map((domain) => [domain.name, domain]),
	)
	const servers = new Map<string, SynthesizedMcpServer>()
	for (const spec of Object.values(registry.capabilitySpecs)) {
		if (spec.source !== 'mcp-server' || !spec.mcpServer) continue
		const key = `mcp-server:${spec.mcpServer.serverId}`
		const existing = servers.get(key)
		if (existing) {
			existing.specs.push(spec)
			existing.operationIdentityFields.push(
				spec.name,
				spec.mcpServer.mcpToolName,
				spec.mcpServer.toolName,
			)
			continue
		}
		const domainMeta = domainsByName.get(spec.domain)
		const fallback = fallbackDomainDescription(spec.mcpServer.serverName)
		const description = domainMeta?.description.trim() || fallback
		const instructions =
			description === fallback ? null : (domainMeta?.description.trim() ?? null)
		servers.set(key, {
			key,
			serverId: spec.mcpServer.serverId,
			serverName: spec.mcpServer.serverName,
			kodyName: spec.mcpServer.kodyName,
			domain: spec.domain,
			description,
			instructions,
			specs: [spec],
			identityFields: [spec.mcpServer.serverName, spec.mcpServer.kodyName],
			operationIdentityFields: [
				spec.name,
				spec.mcpServer.mcpToolName,
				spec.mcpServer.toolName,
			],
			usage: mcpServerUsage(spec.mcpServer.kodyName),
		})
	}
	return [...servers.values()]
}

export function findSynthesizedMcpServer(
	servers: ReadonlyArray<SynthesizedMcpServer>,
	id: string,
): SynthesizedMcpServer | null {
	const normalized = id.trim()
	if (!normalized) return null
	return (
		servers.find((server) => {
			return (
				server.kodyName === normalized ||
				server.serverName === normalized ||
				server.domain === normalized ||
				`mcp:${server.kodyName}` === normalized
			)
		}) ?? null
	)
}

export function buildMcpServerSearchDocument(server: SynthesizedMcpServer) {
	return [
		server.kodyName,
		server.serverName,
		server.domain,
		server.description,
		server.instructions ?? '',
		...server.specs.flatMap((spec) => [
			spec.name,
			spec.description,
			spec.mcpServer?.mcpToolName ?? '',
			spec.mcpServer?.toolName ?? '',
			...(spec.keywords ?? []),
		]),
	]
		.filter((value) => value.trim().length > 0)
		.join('\n')
}

export function buildMcpServerSearchFields(server: SynthesizedMcpServer) {
	return [
		server.kodyName,
		server.serverName,
		server.domain,
		server.description,
		server.instructions ?? '',
		...server.specs.flatMap((spec) => [
			spec.name,
			spec.description,
			spec.mcpServer?.mcpToolName ?? '',
			spec.mcpServer?.toolName ?? '',
			...(spec.keywords ?? []),
		]),
	]
}

export function findWrappingPackageForMcpServer(
	server: SynthesizedMcpServer,
	packageRows: ReadonlyArray<PackageSearchRow>,
): McpServerWrappingPackage | null {
	const serverTokens = new Set(
		server.identityFields.flatMap(extractSearchTokens),
	)
	for (const row of packageRows) {
		const packageTokens = new Set(
			extractSearchTokens(
				[row.record.kodyId, row.record.name, row.record.tags.join(' ')].join(
					'\n',
				),
			),
		)
		const wraps = [...serverTokens].some((token) => packageTokens.has(token))
		if (!wraps) continue
		return {
			kodyId: row.record.kodyId,
			name: row.record.name,
			entityRef: buildEntityRef(row.record.kodyId, 'package'),
		}
	}
	return null
}

export function buildMcpServerToolIndex(
	server: SynthesizedMcpServer,
): Array<McpServerToolIndexEntry> {
	return server.specs.map((spec) => ({
		name: spec.name,
		entityRef: buildEntityRef(spec.name, 'capability'),
		description: spec.description,
		toolName: spec.mcpServer?.toolName ?? spec.name,
		usage: buildKodyCapabilityAccessor(spec),
	}))
}

const sampleCapabilityCount = 3

export function buildMcpServerSearchMatch(input: {
	server: SynthesizedMcpServer
	wrappingPackage?: McpServerWrappingPackage | null
}): Extract<SearchMatch, { type: 'mcp-server' }> {
	return {
		type: 'mcp-server',
		id: input.server.kodyName,
		title: input.server.serverName,
		description: input.server.description,
		domain: input.server.domain,
		source: 'mcp-server',
		kodyName: input.server.kodyName,
		serverName: input.server.serverName,
		serverId: input.server.serverId,
		instructions: input.server.instructions,
		capabilityCount: input.server.specs.length,
		sampleCapabilities: input.server.specs
			.slice(0, sampleCapabilityCount)
			.map((spec) => spec.name),
		usage: input.server.usage,
		wrappingPackage: input.wrappingPackage ?? null,
	}
}

export function queryMatchesSynthesizedMcpServer(input: {
	query: string
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}) {
	const queryTokens = new Set(extractSearchTokens(input.query))
	return listSynthesizedMcpServers(input.registry).some((server) =>
		server.identityFields
			.flatMap(extractSearchTokens)
			.some((token) => queryTokens.has(token)),
	)
}
