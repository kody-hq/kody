import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { buildDomainIndexMatches } from '#mcp/tools/search-domain-index.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'

const capabilitySummarySchema = z.object({
	name: z.string(),
	domain: z.string(),
	description: z.string(),
	keywords: z.array(z.string()),
	readOnly: z.boolean(),
	idempotent: z.boolean(),
	destructive: z.boolean(),
	source: z.enum(['builtin', 'mcp-server']),
	mcpServer: z
		.object({
			serverId: z.string(),
			serverName: z.string(),
			kodyName: z.string(),
			mcpToolName: z.string(),
			toolName: z.string(),
		})
		.optional(),
	requiredInputFields: z.array(z.string()),
})

const capabilityDetailSchema = capabilitySummarySchema.extend({
	inputSchema: z.unknown().optional(),
	outputSchema: z.unknown().optional(),
	inputTypeDefinition: z.string(),
	outputTypeDefinition: z.string().optional(),
	inputFields: z.array(z.string()),
	outputFields: z.array(z.string()),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	domains: z
		.array(
			z.object({
				id: z.string(),
				description: z.string(),
				capabilityCount: z.number().int().nonnegative(),
				sampleCapabilities: z.array(z.string()),
			}),
		)
		.optional(),
	capabilities: z
		.array(z.union([capabilityDetailSchema, capabilitySummarySchema]))
		.optional(),
})

type CapabilitySummary = z.infer<typeof capabilitySummarySchema>
type CapabilityDetail = z.infer<typeof capabilityDetailSchema>
type ListedCapability = CapabilitySummary | CapabilityDetail

function compareCapabilities(
	a: { domain: string; name: string },
	b: { domain: string; name: string },
) {
	return (
		a.domain.localeCompare(b.domain, 'en') || a.name.localeCompare(b.name, 'en')
	)
}

function applyDomainFilter(
	capabilities: Array<ListedCapability>,
	domain: string | undefined,
) {
	if (!domain) return capabilities
	return capabilities.filter((capability) => capability.domain === domain)
}

export const metaListCapabilitiesCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaListCapabilities',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'Browse the current runtime capability registry, including dynamic capabilities from connected MCP servers. Without a domain, returns a compact domain index. Pass a domain for exact capability names and optional TypeScript call shapes.',
		keywords: [
			'capabilities',
			'list',
			'registry',
			'discover',
			'search fallback',
			'dynamic',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			domain: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional domain filter when you only need one capability domain. Accepts builtin domain ids such as "packages" and synthesized MCP server domain ids such as "mcp:home".',
				),
			detail: z
				.boolean()
				.optional()
				.describe(
					'Include TypeScript type definitions and full field lists when true. Defaults to false.',
				),
		}),
		outputSchema,
		async handler(
			args: { domain?: string; detail?: boolean },
			ctx: CapabilityContext,
		) {
			// Avoid a module cycle: registry -> builtin domains -> meta domain -> this file.
			const { getCapabilityRegistryForContext } =
				await import('#mcp/capabilities/registry.ts')
			const { filterCapabilityRegistryMcpServersForCaller } =
				await import('#mcp/capabilities/access-control.ts')
			const { listVisibleEnabledMcpServerRefsCached } =
				await import('#worker/mcp-client/settings-service.ts')
			const runtimeRegistry = await getCapabilityRegistryForContext({
				env: ctx.env,
				callerContext: ctx.callerContext,
			})
			// Match registry synthesis: MCP servers are org-owned, so visibility
			// must use the bound org (ownerIdFromCaller), not the personal org.
			// Otherwise team tools appear in the runtime registry but get filtered
			// out of metaListCapabilities / discovery.
			const ownerId = ownerIdFromCaller(ctx.callerContext) || null
			const registry = ownerId
				? filterCapabilityRegistryMcpServersForCaller(
						runtimeRegistry,
						new Set(
							(
								await listVisibleEnabledMcpServerRefsCached({
									env: ctx.env,
									userId: ownerId,
									packageId: ctx.callerContext.storageContext?.packageId,
								}).catch(() => [])
							).map((ref) => ref.serverId),
						),
					)
				: runtimeRegistry
			if (!args.domain) {
				const domains = buildDomainIndexMatches({
					capabilityDomains: registry.capabilityDomains ?? [],
					capabilitySpecs: registry.capabilitySpecs,
				}).map((domain) => {
					if (domain.type !== 'domain') {
						throw new Error('Domain index contained a non-domain match.')
					}
					return {
						id: domain.name,
						description: domain.description,
						capabilityCount: domain.capabilityCount,
						sampleCapabilities: domain.sampleCapabilities,
					}
				})
				return {
					total: domains.length,
					domains,
				}
			}
			const allCapabilities = Object.values(registry.capabilitySpecs)
				.map((spec) =>
					args.detail
						? {
								name: spec.name,
								domain: spec.domain,
								description: spec.description,
								keywords: spec.keywords,
								readOnly: spec.readOnly,
								idempotent: spec.idempotent,
								destructive: spec.destructive,
								source: spec.source,
								...(spec.mcpServer ? { mcpServer: spec.mcpServer } : {}),
								requiredInputFields: spec.requiredInputFields,
								inputTypeDefinition: spec.inputTypeDefinition,
								...(spec.outputTypeDefinition
									? { outputTypeDefinition: spec.outputTypeDefinition }
									: {}),
								inputFields: spec.inputFields,
								outputFields: spec.outputFields,
							}
						: {
								name: spec.name,
								domain: spec.domain,
								description: spec.description,
								keywords: spec.keywords,
								readOnly: spec.readOnly,
								idempotent: spec.idempotent,
								destructive: spec.destructive,
								source: spec.source,
								...(spec.mcpServer ? { mcpServer: spec.mcpServer } : {}),
								requiredInputFields: spec.requiredInputFields,
							},
				)
				.sort(compareCapabilities)
			const filteredCapabilities = applyDomainFilter(
				allCapabilities,
				args.domain,
			)
			return {
				total: filteredCapabilities.length,
				capabilities: filteredCapabilities,
			}
		},
	},
)
