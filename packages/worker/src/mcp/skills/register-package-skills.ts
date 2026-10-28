import {
	catalogReadResource,
	recordSkillRead,
} from '#worker/package-registry/skill-read-events.ts'
import { type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { mcpSkillsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import { resolveCallerFeatureFlags } from '#mcp/capabilities/access-control.ts'
import {
	listCatalogSkillResources,
	buildSkillResourcesListResult,
	buildSkillsGetResult,
	buildSkillsListResult,
	loadCallerSkillsCatalog,
	readCatalogSkillResource,
} from './skills-catalog.ts'
import {
	clientAdvertisesSkillsExtension,
	skillsExtensionId,
} from './skills-extension.ts'

const SkillsListParams = z.object({ cursor: z.string().optional() })
const SkillsGetParams = z.object({ uri: z.string() })

/**
 * Registers the Skills-over-MCP (SEP-2640) surface on a per-request server:
 * the extension capability, `skills/list`, `skills/get`, and the `skill://`
 * `resources/list` / `resources/read` handlers. Callers must already have
 * checked the feature flag and the client's extension support; use
 * {@link registerPackageSkillsExtensionWhenEnabled} for the gated entry point.
 *
 * The caller's catalog is loaded lazily and at most once per request.
 */
export function registerPackageSkillsExtension(input: {
	server: McpServer
	env: Env
	callerContext: McpCallerContext
}) {
	const { server, env, callerContext } = input
	let catalogPromise: ReturnType<typeof loadCallerSkillsCatalog> | null = null
	const getCatalog = () => {
		catalogPromise ??= loadCallerSkillsCatalog({ env, callerContext })
		return catalogPromise
	}

	server.server.registerCapabilities({
		resources: {},
		extensions: { [skillsExtensionId]: {} },
	})
	server.server.setRequestHandler(
		'skills/list',
		{ params: SkillsListParams },
		async () => buildSkillsListResult(await getCatalog()),
	)
	server.server.setRequestHandler(
		'skills/get',
		{ params: SkillsGetParams },
		async (params) => buildSkillsGetResult(await getCatalog(), params.uri),
	)
	server.server.setRequestHandler('resources/list', async () =>
		buildSkillResourcesListResult(await getCatalog()),
	)
	server.server.setRequestHandler('resources/read', async (request) => {
		const catalog = await getCatalog()
		const result = await readCatalogSkillResource({
			env,
			callerContext,
			catalog,
			uri: request.params.uri,
		})
		const match = listCatalogSkillResources(catalog).find(
			({ resource }) => resource.uri === request.params.uri,
		)!
		await recordSkillRead({
			env,
			callerContext,
			channel: 'mcp-resource',
			resource: catalogReadResource(match),
		})
		return result
	})
}

/**
 * Progressive enhancement: registers the skills extension only when the
 * `mcp-skills-extension` flag is on for the caller and the client declared the
 * extension in its per-request capabilities. Anonymous callers fail closed
 * because flags are evaluated per user.
 */
export async function registerPackageSkillsExtensionWhenEnabled(input: {
	server: McpServer
	env: Env
	callerContext: McpCallerContext
	parsedBody: unknown
}) {
	if (!clientAdvertisesSkillsExtension(input.parsedBody)) return false
	const flags = await resolveCallerFeatureFlags(input.env, input.callerContext)
	if (!flags[mcpSkillsExtensionFlagKey]) return false
	registerPackageSkillsExtension(input)
	return true
}
