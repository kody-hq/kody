import { searchCapabilities } from '#mcp/capabilities/capability-search.ts'
import type { CapabilitySpec } from '#mcp/capabilities/types.ts'
import { capabilityApiAvailabilitySummary } from '#worker/open-api/api-capability-surface.ts'

import { formatMarkdownInlineCode } from '../markdown-safety.ts'
import {
	buildCapabilityExecuteExample,
	buildCapabilityUsage,
	buildEntityRef,
	formatList,
} from '../search-format-helpers.ts'
import type { SearchEntityPlugin } from '../search-entity-plugin.ts'
import type { SearchMatch } from '../search-format-types.ts'
import { buildCandidateBaseScore } from '../search-scoring.ts'
import type { SearchCandidate, SearchCapabilityMatch } from '../search-types.ts'

function getSynthesizedProviderIdentity(spec: CapabilitySpec):
	| {
			key: string
			providerFields: Array<string>
			operationFields: Array<string>
	  }
	| undefined {
	switch (spec.source) {
		case 'builtin':
			return undefined
		case 'mcp-server':
			return spec.mcpServer
				? {
						key: `mcp-server:${spec.mcpServer.serverId}`,
						providerFields: [
							spec.mcpServer.serverName,
							spec.mcpServer.kodyName,
						],
						operationFields: [
							spec.mcpServer.mcpToolName,
							spec.mcpServer.toolName,
						],
					}
				: undefined
		default: {
			const exhaustiveSource: never = spec.source
			return exhaustiveSource
		}
	}
}

export function toCapabilitySearchMatch(
	spec: CapabilitySpec,
): Extract<SearchMatch, { type: 'capability' }> {
	return {
		type: 'capability',
		name: spec.name,
		title: spec.name,
		description: spec.description,
		domain: spec.domain,
		source: spec.source,
		...(spec.mcpServer ? { mcpServer: spec.mcpServer } : {}),
	}
}

function capabilityMatchToCandidate(
	match: SearchCapabilityMatch,
	spec: CapabilitySpec,
): SearchCandidate {
	const providerIdentity = getSynthesizedProviderIdentity(spec)
	return {
		match: toCapabilitySearchMatch(spec),
		type: 'capability',
		id: spec.name,
		title: spec.name,
		searchFields: [
			spec.name,
			spec.domain,
			spec.description,
			...(spec.keywords ?? []),
			...(spec.inputFields ?? []),
			...(spec.outputFields ?? []),
		],
		identityFields: [
			spec.name,
			spec.domain,
			...(providerIdentity?.operationFields ?? []),
		],
		...(providerIdentity
			? {
					providerIdentityFields: providerIdentity.providerFields,
					synthesizedProviderKey: providerIdentity.key,
				}
			: {}),
		scoreComponents: buildCandidateBaseScore({
			lexical: match.lexicalScore,
			...(match.vectorRank != null ? { vector: match.vectorScore } : {}),
		}),
	}
}

export const capabilitySearchEntityPlugin = {
	type: 'capability',
	candidateTimingKey: 'capabilityCandidatesMs',
	buildDescriptors(input) {
		return Object.values(input.registry.capabilitySpecs)
			.filter((spec) => spec.source !== 'mcp-server' || Boolean(input.domain))
			.map((spec) => ({
				type: 'capability' as const,
				id: spec.name,
				title: spec.name,
				primaryAliases: [spec.name],
				secondaryAliases: [
					spec.domain,
					spec.description,
					...(spec.keywords ?? []),
				],
				tertiaryAliases: [
					...(spec.inputFields ?? []),
					...(spec.outputFields ?? []),
				],
			}))
	},
	async buildCandidates(input) {
		const specs = Object.fromEntries(
			Object.entries(input.registry.capabilitySpecs).filter(
				([, spec]) => spec.source !== 'mcp-server' || Boolean(input.domain),
			),
		)
		const capabilitySearch = await searchCapabilities({
			env: input.env,
			query: input.query,
			limit: Math.max(1, Object.keys(specs).length),
			detail: false,
			specs,
			...(input.sharedQueryVector
				? { queryVector: input.sharedQueryVector }
				: {}),
		})

		return capabilitySearch.matches
			.map((match) => {
				const spec = specs[match.name]
				if (!spec || spec.name !== match.name) {
					throw new Error(
						`Capability search result "${match.name}" did not map to a registry spec by name.`,
					)
				}
				return capabilityMatchToCandidate(match, spec)
			})
			.filter((candidate) => candidate.scoreComponents.base > 0)
	},
	formatSlimMatch({ match }) {
		const apiAvailability = capabilityApiAvailabilitySummary(match.name)
		return {
			type: 'capability',
			id: match.name,
			entityRef: buildEntityRef(match.name, 'capability'),
			title: match.title ?? match.name,
			description:
				'description' in match && typeof match.description === 'string'
					? match.description
					: '',
			domain: match.domain,
			usage: buildCapabilityUsage(match),
			apiAvailable: apiAvailability.apiAvailable,
			...(match.source ? { source: match.source } : {}),
			...(match.mcpServer ? { mcpServer: match.mcpServer } : {}),
			...(match.inputTypeDefinition
				? { inputTypeDefinition: match.inputTypeDefinition }
				: {}),
			...(match.inputTypeDefinitionTruncated
				? { inputTypeDefinitionTruncated: true }
				: {}),
		}
	},
	formatEntityDetail(detail, options) {
		const relatedOperationCount = detail.relatedOperationCount ?? 0
		const apiAvailability = capabilityApiAvailabilitySummary(detail.spec.name)
		const lines = [
			`# Capability — \`${detail.title}\``,
			'',
			detail.spec.description,
			'',
			'## Summary',
			'',
			`- Entity: \`${buildEntityRef(detail.id, 'capability')}\``,
			`- Domain: \`${detail.spec.domain}\``,
			`- Source: \`${detail.spec.source}\``,
			`- Required input fields: ${formatList(detail.spec.requiredInputFields)}`,
			`- Read-only: ${detail.spec.readOnly ? 'yes' : 'no'}`,
			`- Idempotent: ${detail.spec.idempotent ? 'yes' : 'no'}`,
			`- Destructive: ${detail.spec.destructive ? 'yes' : 'no'}`,
			`- ${apiAvailability.summary}`,
			'',
			'## Execute from `execute`',
			'',
			...((options?.includeBoilerplate ?? true)
				? [
						'Capabilities returned by `search` are available inside `execute` on the imported `kody` object.',
						'',
					]
				: []),
			'```ts',
			buildCapabilityExecuteExample(detail.spec),
			'```',
			...((options?.includeBoilerplate ?? true)
				? [
						'',
						'Pass concrete arguments as execute `params` that satisfy the input type below; use `{}` when there are no required fields.',
					]
				: []),
			'',
			'## Type definitions',
			'',
			'```ts',
			detail.spec.inputTypeDefinition,
			...(detail.spec.outputTypeDefinition
				? ['', detail.spec.outputTypeDefinition]
				: []),
			'```',
		]
		if (relatedOperationCount > 0) {
			lines.push(
				'',
				`- Related operations from this MCP server: ${String(relatedOperationCount)}. Use ${formatMarkdownInlineCode(`search({ entity: ${JSON.stringify(buildEntityRef(detail.spec.mcpServer?.kodyName ?? detail.spec.domain, 'mcp-server'))} })`)} or ${formatMarkdownInlineCode(`search({ domain: ${JSON.stringify(detail.spec.domain)} })`)} to list them.`,
			)
		}
		return {
			markdown: lines.join('\n'),
			structured: {
				kind: 'entity',
				type: 'capability',
				id: detail.id,
				entityRef: buildEntityRef(detail.id, 'capability'),
				title: detail.title,
				description: detail.description,
				usage: buildCapabilityUsage(detail.spec),
				apiAvailable: apiAvailability.apiAvailable,
				executeExample: buildCapabilityExecuteExample(detail.spec),
				requiredInputFields: detail.spec.requiredInputFields,
				readOnly: detail.spec.readOnly,
				idempotent: detail.spec.idempotent,
				destructive: detail.spec.destructive,
				source: detail.spec.source,
				...(detail.spec.mcpServer ? { mcpServer: detail.spec.mcpServer } : {}),
				inputTypeDefinition: detail.spec.inputTypeDefinition,
				...(detail.spec.outputTypeDefinition
					? { outputTypeDefinition: detail.spec.outputTypeDefinition }
					: {}),
				...(relatedOperationCount > 0 ? { relatedOperationCount } : {}),
			},
		}
	},
} satisfies SearchEntityPlugin<'capability'>

export async function buildCapabilityCandidates(
	input: Parameters<
		NonNullable<typeof capabilitySearchEntityPlugin.buildCandidates>
	>[0],
) {
	return await capabilitySearchEntityPlugin.buildCandidates(input)
}
