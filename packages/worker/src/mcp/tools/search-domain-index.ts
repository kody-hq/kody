import type {
	CapabilityDomainMetadata,
	CapabilitySpec,
} from '#mcp/capabilities/types.ts'

import type { SearchMatch } from './search-format-types.ts'

const sampleCapabilityCount = 3

function buildDomainMatch(
	domain: CapabilityDomainMetadata,
	specs: ReadonlyArray<CapabilitySpec>,
): SearchMatch {
	return {
		type: 'domain',
		name: domain.name,
		title: domain.name,
		description: domain.description,
		capabilityCount: specs.length,
		sampleCapabilities: specs
			.slice(0, sampleCapabilityCount)
			.map((spec) => spec.name),
	}
}

export function buildDomainIndexMatches(input: {
	capabilityDomains: ReadonlyArray<CapabilityDomainMetadata>
	capabilitySpecs: Record<string, CapabilitySpec>
}): Array<SearchMatch> {
	const specsByDomain = new Map<string, Array<CapabilitySpec>>()
	for (const spec of Object.values(input.capabilitySpecs)) {
		const group = specsByDomain.get(spec.domain) ?? []
		group.push(spec)
		specsByDomain.set(spec.domain, group)
	}
	return input.capabilityDomains
		.filter((domain) => (specsByDomain.get(domain.name)?.length ?? 0) > 0)
		.map((domain) =>
			buildDomainMatch(domain, specsByDomain.get(domain.name) ?? []),
		)
}
