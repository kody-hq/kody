import { type SearchEntityPlugin } from '../search-entity-plugin.ts'

/**
 * Domain summaries come from the broad-query overview in `searchUnified`,
 * not from the candidate pipeline,
 * and there is no `{id}:domain` entity detail.
 */
export const domainSearchEntityPlugin = {
	type: 'domain',
	formatSlimMatch({ match }) {
		return {
			type: 'domain',
			id: match.name,
			name: match.name,
			title: match.title,
			description: match.description,
			capabilityCount: match.capabilityCount,
			sampleCapabilities: match.sampleCapabilities,
			usage: `search({ query: "<task>", domain: ${JSON.stringify(match.name)} }) or search({ domain: ${JSON.stringify(match.name)} })`,
		}
	},
} satisfies SearchEntityPlugin<'domain'>
