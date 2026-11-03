import { deterministicEmbedding } from '#worker/vectorize/embedding.ts'
import { cosineSimilarity, lexicalScore } from '#worker/vectorize/scoring.ts'

import type { SearchEntityPlugin } from '../search-entity-plugin.ts'
import {
	escapeMarkdownText,
	formatMarkdownInlineCode,
} from '../markdown-safety.ts'
import { formatOneLineSentence } from '../search-format-helpers.ts'
import {
	buildMcpServerSearchDocument,
	buildMcpServerSearchFields,
	buildMcpServerSearchMatch,
	findWrappingPackageForMcpServer,
	listSynthesizedMcpServers,
	mcpServerEntityRef,
	mcpServerUsage,
} from '../search-mcp-servers.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'

export const mcpServerSearchEntityPlugin = {
	type: 'mcp-server',
	buildDescriptors(input) {
		if (input.domain) return []
		return listSynthesizedMcpServers(input.registry).map((server) => ({
			type: 'mcp-server' as const,
			id: server.kodyName,
			title: server.serverName,
			primaryAliases: [server.kodyName, server.serverName, server.domain],
			secondaryAliases: [server.description, server.instructions ?? ''],
			tertiaryAliases: server.specs.flatMap((spec) => [
				spec.name,
				spec.description,
				spec.mcpServer?.mcpToolName ?? '',
				spec.mcpServer?.toolName ?? '',
			]),
		}))
	},
	buildCandidates(input) {
		if (input.domain) return []
		return listSynthesizedMcpServers(input.registry)
			.map((server) => {
				const wrappingPackage = findWrappingPackageForMcpServer(
					server,
					input.optionalRows.packageRows,
				)
				const document = buildMcpServerSearchDocument(server)
				const lexical = lexicalScore(input.query, document)
				const vector = cosineSimilarity(
					input.queryEmbedding,
					deterministicEmbedding(document),
				)
				return {
					match: buildMcpServerSearchMatch({ server, wrappingPackage }),
					type: 'mcp-server' as const,
					id: server.kodyName,
					title: server.serverName,
					searchFields: buildMcpServerSearchFields(server),
					identityFields: server.identityFields,
					providerIdentityFields: [server.serverName, server.kodyName],
					synthesizedProviderKey: server.key,
					scoreComponents: buildCandidateBaseScore({
						lexical,
						vector,
					}),
				}
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		return {
			type: 'mcp-server',
			id: match.kodyName,
			entityRef: mcpServerEntityRef(match.kodyName),
			title: match.title,
			description: match.description,
			domain: match.domain,
			source: match.source,
			kodyName: match.kodyName,
			serverName: match.serverName,
			instructions: match.instructions,
			capabilityCount: match.capabilityCount,
			sampleCapabilities: match.sampleCapabilities,
			usage: match.usage,
			wrappingPackage: match.wrappingPackage,
		}
	},
	formatEntityDetail(detail) {
		const entityRef = mcpServerEntityRef(detail.kodyName)
		const usage = mcpServerUsage(detail.kodyName)
		const instructions = detail.instructions?.trim() || null
		const wrappingPackage = detail.wrappingPackage
		const lines = [
			`# MCP server — \`${detail.serverName}\``,
			'',
			detail.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${entityRef}\``,
			`- Domain: \`${detail.domain}\``,
			`- Tools: ${String(detail.tools.length)}`,
			`- Call via \`${usage}\``,
		]
		if (wrappingPackage) {
			lines.push(
				`- Wrapping package: ${formatMarkdownInlineCode(wrappingPackage.name)} (Entity: ${formatMarkdownInlineCode(wrappingPackage.entityRef)})`,
			)
		}
		if (instructions) {
			lines.push('', '## Server instructions', '', instructions)
		}
		lines.push(
			'',
			'## Tools',
			'',
			'Inspect a tool with `search({ entity: "capability:<id>" })`, then call it from `execute`.',
			'',
		)
		if (detail.tools.length === 0) {
			lines.push('No discovered tools.')
		} else {
			for (const tool of detail.tools) {
				lines.push(
					`- ${formatMarkdownInlineCode(tool.toolName)} — ${escapeMarkdownText(formatOneLineSentence(tool.description))} Entity: ${formatMarkdownInlineCode(tool.entityRef)}. Call ${formatMarkdownInlineCode(`${tool.usage}(args)`)}.`,
				)
			}
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'mcp-server',
				id: detail.id,
				entityRef,
				title: detail.title,
				description: detail.description,
				usage,
				domain: detail.domain,
				kodyName: detail.kodyName,
				serverName: detail.serverName,
				serverId: detail.serverId,
				instructions,
				capabilityCount: detail.tools.length,
				tools: detail.tools,
				wrappingPackage,
			},
		}
	},
} satisfies SearchEntityPlugin<'mcp-server'>
