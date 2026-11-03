import { getSearchEntityPluginForDetail } from './search-entity-registry.ts'
import type { SearchEntityDetail } from './search-format-types.ts'

export function formatEntityDetailMarkdown(
	detail: SearchEntityDetail,
	options?: { includeBoilerplate?: boolean },
) {
	const plugin = getSearchEntityPluginForDetail(detail)
	if (!plugin?.formatEntityDetail) {
		throw new Error(`No detail formatter registered for ${detail.type}.`)
	}
	return plugin.formatEntityDetail(detail as never, options)
}
