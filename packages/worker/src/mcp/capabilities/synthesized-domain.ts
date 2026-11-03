import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import type { CapabilityDomain } from '#mcp/capabilities/domain-metadata.ts'
import type { Capability, DomainSpec } from '#mcp/capabilities/types.ts'

export function tokenizeCapabilityKeywords(
	words: ReadonlyArray<string>,
): Array<string> {
	return Array.from(
		new Set(
			words
				.join(' ')
				.toLowerCase()
				.match(/[a-z0-9_]+/g)
				?.filter(Boolean) ?? [],
		),
	)
}

export function readMcpToolAnnotationHints(annotations: unknown): {
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
} {
	const hints =
		annotations && typeof annotations === 'object'
			? (annotations as Record<string, unknown>)
			: {}
	return {
		readOnly: Boolean(hints['readOnlyHint']),
		idempotent: Boolean(hints['idempotentHint']),
		destructive: Boolean(hints['destructiveHint']),
	}
}

export function defineSynthesizedDomain(input: {
	name: CapabilityDomain
	description: string
	keywords: ReadonlyArray<string>
	capabilities: Array<Capability>
}): DomainSpec {
	return defineDomain({
		name: input.name,
		description: input.description,
		keywords: [...input.keywords],
		capabilities: input.capabilities,
	})
}
