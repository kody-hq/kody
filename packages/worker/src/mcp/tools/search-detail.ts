import { resolveHostedPackageAppUrl } from '@kody-internal/shared/public-urls.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { callerHasRole } from '#mcp/capabilities/access-control.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { importGuideCatalog } from '#worker/guide-catalog-modules.ts'
import {
	guideNotFoundMessage,
	resolveCatalogGuide,
	suggestCatalogGuideIds,
} from '#worker/guides/resolve-catalog-guide.ts'
import {
	getJoinedIntegration,
	toJoinedIntegrationConfig,
} from '#worker/integrations/service.ts'
import { applySavedPackageForkListingAncestry } from '#worker/community/fork-listing-relation.ts'
import { resolveSavedPackageRefWithCommunityProvenance } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'

import { collectIntegrationPackageSuggestions } from './integration-package-suggestions.ts'
import { parseEntityRef } from './search-format.ts'
import {
	buildMcpServerToolIndex,
	findSynthesizedMcpServer,
	findWrappingPackageForMcpServer,
	listSynthesizedMcpServers,
	mcpServerUsage,
} from './search-mcp-servers.ts'
import { countRelatedCapabilityOperations } from './search-related-capabilities.ts'
import { type SearchRowsAndRegistry } from './search-types.ts'

export async function resolveEntityDetail(input: {
	agent: McpRegistrationAgent
	callerContext: ReturnType<McpRegistrationAgent['getCallerContext']>
	userId: string | null
	username: string | null
	entity: string
	searchRows: SearchRowsAndRegistry
}) {
	const ref = parseEntityRef(input.entity)
	if (ref.section && ref.type !== 'guide' && ref.type !== 'package') {
		throw new McpCallerError(
			'Section fragments are only supported on guide and package entities. Use "guide:{id}#{heading}" or "package:{id}#{subpath}".',
		)
	}
	if (ref.type === 'mcp-server') {
		const server = findSynthesizedMcpServer(
			listSynthesizedMcpServers(input.searchRows.registry),
			ref.id,
		)
		if (!server) {
			throw new McpCallerError('MCP server not found.')
		}
		return {
			type: 'mcp-server' as const,
			id: server.kodyName,
			title: server.serverName,
			description: server.description,
			domain: server.domain,
			kodyName: server.kodyName,
			serverName: server.serverName,
			serverId: server.serverId,
			instructions: server.instructions,
			usage: mcpServerUsage(server.kodyName),
			tools: buildMcpServerToolIndex(server),
			wrappingPackage: findWrappingPackageForMcpServer(
				server,
				input.searchRows.packageRows,
			),
		}
	}

	if (ref.type === 'capability') {
		const spec = input.searchRows.registry.capabilitySpecs[ref.id]
		if (!spec) {
			throw new McpCallerError('Capability not found.')
		}
		const relatedOperationCount = countRelatedCapabilityOperations({
			spec,
			registry: input.searchRows.registry,
		})
		return {
			type: 'capability' as const,
			id: ref.id,
			title: spec.name,
			description: spec.description,
			spec,
			...(relatedOperationCount > 0 ? { relatedOperationCount } : {}),
		}
	}

	if (ref.type === 'guide') {
		const { guides } = await importGuideCatalog()
		// Entity lookup: catalog id, slug, or a merged-doc alias.
		const includeAdmin = callerHasRole(input.callerContext, 'admin')
		const resolved = resolveCatalogGuide(guides, ref.id)
		if (!resolved) {
			throw new McpCallerError(
				guideNotFoundMessage(
					suggestCatalogGuideIds(guides, ref.id, { includeAdmin }),
				),
			)
		}
		const guide =
			guides.find((candidate) => candidate.id === resolved.id) ?? null
		if (!guide || (guide.adminOnly && !includeAdmin)) {
			throw new McpCallerError('Guide not found.')
		}
		const section = ref.section ?? resolved.aliasSection
		return {
			type: 'guide' as const,
			id: guide.id,
			title: guide.title,
			description: guide.summary,
			body: guide.body,
			slug: guide.slug,
			category: guide.category,
			provider: guide.provider,
			lastVerified: guide.lastVerified,
			...(section ? { section } : {}),
		}
	}

	if (!input.userId) {
		throw new McpCallerError(
			'Authentication required to access saved user entities.',
		)
	}

	if (ref.type === 'package') {
		const env = input.agent.getEnv()
		const loadedOwnRecord = await resolveSavedPackageRefWithCommunityProvenance(
			env.APP_DB,
			{
				userId: input.userId,
				ref: ref.id,
			},
		)
		const [record] = loadedOwnRecord
			? await applySavedPackageForkListingAncestry({
					env,
					records: [loadedOwnRecord],
				})
			: [null]
		if (!record) {
			throw new McpCallerError('Saved package not found for this user.')
		}
		const loaded = await loadPackageSourceBySourceId({
			env,
			baseUrl: input.callerContext.baseUrl,
			userId: input.userId,
			sourceId: record.sourceId,
		})
		const packageAppOrigin = getPackageAppBaseUrl({ env })
		const ownerUsername = input.username
		return {
			type: 'package' as const,
			id: record.kodyId,
			title: record.name,
			description: record.description,
			record,
			manifest: loaded.manifest,
			files: loaded.files,
			baseUrl: input.callerContext.baseUrl,
			ownerUsername,
			listingAhead: record.listingAhead ?? null,
			hostedUrl:
				record.hasApp && ownerUsername
					? ((
							await resolvePublicPackageAppLocation({
								env,
								username: ownerUsername,
								kodyId: record.kodyId,
							})
						)?.hostedUrl ??
						resolveHostedPackageAppUrl({
							packageAppBaseUrl: packageAppOrigin,
							appBaseUrl: input.callerContext.baseUrl,
							username: ownerUsername,
							kodyId: record.kodyId,
						}))
					: null,
			...(ref.section ? { section: ref.section } : {}),
		}
	}

	if (ref.type === 'integration') {
		const joined = await getJoinedIntegration({
			env: input.agent.getEnv(),
			userId: input.userId,
			name: ref.id,
		})
		const visible =
			joined &&
			input.searchRows.userIntegrationRows.some(
				(row) => row.connection.name === joined.connection.name,
			)
		if (!joined || !visible) {
			throw new McpCallerError('Saved integration not found for this user.')
		}
		const config = toJoinedIntegrationConfig(joined)
		const relatedPackageSuggestions =
			await collectIntegrationPackageSuggestions({
				env: input.agent.getEnv(),
				baseUrl: input.callerContext.baseUrl,
				integration: config,
				packageRows: input.searchRows.packageRows,
			})
		return {
			type: 'integration' as const,
			id: config.name,
			title: config.name,
			description:
				joined.connection.description.trim() ||
				`Saved OAuth integration configuration (${config.flow} flow).`,
			config,
			...(relatedPackageSuggestions.length > 0
				? { relatedPackageSuggestions }
				: {}),
		}
	}

	const row = input.searchRows.userSecretRows.find(
		(secret) => secret.name === ref.id,
	)
	if (!row) {
		throw new McpCallerError('Secret not found for this user.')
	}
	return {
		type: 'secret' as const,
		id: row.name,
		title: row.name,
		description: row.description,
		row,
	}
}
