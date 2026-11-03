import { defineCapability } from './define-capability.ts'
import type { CapabilityDomain } from './domain-metadata.ts'
import type {
	Capability,
	CapabilityDefinition,
	CapabilityOutput,
	CapabilitySchemaDefinition,
} from './types.ts'

export function defineDomainCapability<
	TInputSchema extends CapabilitySchemaDefinition,
	TOutputSchema extends CapabilitySchemaDefinition | undefined = undefined,
>(
	domain: CapabilityDomain,
	definition: Omit<CapabilityDefinition<TInputSchema, TOutputSchema>, 'domain'>,
): Capability<CapabilityOutput<TOutputSchema>> {
	return defineCapability({
		...definition,
		domain,
	})
}
