import type { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'

import {
	maxRelatedCapabilityOperations,
	topCapabilityInlineCallShapeCount,
} from './search-constants.ts'
import {
	type RelatedCapabilityOperation,
	type SearchMatch,
	compactCapabilityInputTypeDefinition,
} from './search-format.ts'

export function attachTopCapabilityCallShapes(input: {
	matches: Array<SearchMatch>
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
	limit?: number
}): void {
	const limit = input.limit ?? topCapabilityInlineCallShapeCount
	let attached = 0
	for (const match of input.matches) {
		if (attached >= limit) break
		if (match.type !== 'capability') continue
		const spec = input.registry.capabilitySpecs[match.name]
		if (!spec?.inputTypeDefinition) continue
		const compact = compactCapabilityInputTypeDefinition(
			spec.inputTypeDefinition,
			{ requiredInputFields: spec.requiredInputFields },
		)
		match.inputTypeDefinition = compact.definition
		if (compact.truncated) {
			match.inputTypeDefinitionTruncated = true
		}
		attached += 1
	}
}

function sameSynthesizedProvider(
	left: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string],
	right: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string],
): boolean {
	if (left.source !== right.source) return false
	if (left.source === 'mcp-server' && left.mcpServer && right.mcpServer) {
		return left.mcpServer.kodyName === right.mcpServer.kodyName
	}
	return false
}

export function collectRelatedCapabilityOperations(input: {
	spec: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string]
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}): Array<RelatedCapabilityOperation> {
	const { spec, registry } = input
	if (spec.source !== 'mcp-server') {
		return []
	}
	return Object.values(registry.capabilitySpecs)
		.filter(
			(other) =>
				other.name !== spec.name && sameSynthesizedProvider(spec, other),
		)
		.sort((left, right) => left.name.localeCompare(right.name))
		.slice(0, maxRelatedCapabilityOperations)
		.map((other) => ({
			name: other.name,
			entityRef: `capability:${other.name}`,
			description: other.description,
		}))
}

export function countRelatedCapabilityOperations(input: {
	spec: Awaited<
		ReturnType<typeof getCapabilityRegistryForContext>
	>['capabilitySpecs'][string]
	registry: Awaited<ReturnType<typeof getCapabilityRegistryForContext>>
}): number {
	if (input.spec.source !== 'mcp-server') {
		return 0
	}
	return Object.values(input.registry.capabilitySpecs).filter(
		(other) =>
			other.name !== input.spec.name &&
			sameSynthesizedProvider(input.spec, other),
	).length
}
