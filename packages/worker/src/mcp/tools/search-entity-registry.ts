import { capabilitySearchEntityPlugin } from './search-entity-plugins/capability.ts'
import { domainSearchEntityPlugin } from './search-entity-plugins/domain.ts'
import { guideSearchEntityPlugin } from './search-entity-plugins/guide.ts'
import { integrationSearchEntityPlugin } from './search-entity-plugins/integration.ts'
import { mcpServerSearchEntityPlugin } from './search-entity-plugins/mcp-server.ts'
import { packageSearchEntityPlugin } from './search-entity-plugins/package.ts'
import { secretSearchEntityPlugin } from './search-entity-plugins/secret.ts'
import {
	type SearchEntityDetail,
	type SearchMatch,
} from './search-format-types.ts'

export const searchEntityPlugins = [
	capabilitySearchEntityPlugin,
	guideSearchEntityPlugin,
	packageSearchEntityPlugin,
	integrationSearchEntityPlugin,
	mcpServerSearchEntityPlugin,
	secretSearchEntityPlugin,
	domainSearchEntityPlugin,
] as const

type RegisteredSearchEntityPlugin = (typeof searchEntityPlugins)[number]
type DetailSearchEntityPlugin = Extract<
	RegisteredSearchEntityPlugin,
	{ formatEntityDetail: unknown }
>

function hasDetailFormatter(
	plugin: RegisteredSearchEntityPlugin,
): plugin is DetailSearchEntityPlugin {
	return 'formatEntityDetail' in plugin
}

export const searchableEntityTypes = searchEntityPlugins.map(
	(plugin) => plugin.type,
)

export const entityDetailTypes = searchEntityPlugins
	.filter(hasDetailFormatter)
	.map((plugin) => plugin.type)

export function getSearchEntityPluginForMatch(match: SearchMatch) {
	return searchEntityPlugins.find((plugin) => plugin.type === match.type)
}

export function getSearchEntityPluginForDetail(detail: SearchEntityDetail) {
	const plugin = searchEntityPlugins.find(
		(candidate) => candidate.type === detail.type,
	)
	if (!plugin || !hasDetailFormatter(plugin)) return undefined
	return plugin
}
