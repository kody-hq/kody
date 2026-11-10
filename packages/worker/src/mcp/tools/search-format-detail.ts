import type { SearchEntityDetailFormatOptions } from './search-entity-plugin.ts'
import { getSearchEntityPluginForDetail } from './search-entity-registry.ts'
import type { SearchEntityDetail } from './search-format-types.ts'

export function formatEntityDetailMarkdown(
	detail: SearchEntityDetail,
	options?: SearchEntityDetailFormatOptions,
) {
	const plugin = getSearchEntityPluginForDetail(detail)
	if (!plugin?.formatEntityDetail) {
		throw new Error(`No detail formatter registered for ${detail.type}.`)
	}
	return plugin.formatEntityDetail(detail as never, options)
}
