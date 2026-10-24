import { type JsonSchemaToolDescriptors } from '@cloudflare/codemode'
import { defineDomain } from './define-domain.ts'
import { type CapabilityDomain } from './domain-metadata.ts'
import {
	type Capability,
	type CapabilityDomainMetadata,
	type CapabilitySpec,
	type DomainSpec,
} from './types.ts'

export type BuiltCapabilityRegistry = {
	capabilityList: Array<Capability>
	capabilityDomains: ReadonlyArray<CapabilityDomainMetadata>
	capabilityDomainDescriptionsByName: Record<CapabilityDomain, string>
	capabilityMap: Record<string, Capability>
	capabilitySpecs: Record<string, CapabilitySpec>
	capabilityToolDescriptors: JsonSchemaToolDescriptors
	capabilityHandlers: Record<string, Capability['handler']>
}

export function buildCapabilityRegistry(
	domains: ReadonlyArray<DomainSpec>,
): BuiltCapabilityRegistry {
	const normalized = domains.map((domain) => defineDomain(domain))

	const seenRegistryDomains = new Set<CapabilityDomain>()
	for (const domain of normalized) {
		if (seenRegistryDomains.has(domain.name)) {
			throw new Error(`Duplicate domain registration: ${domain.name}`)
		}
		seenRegistryDomains.add(domain.name)
	}

	const advertised = normalized.filter((domain) => !domain.unadvertised)

	const capabilityDomains: ReadonlyArray<CapabilityDomainMetadata> =
		advertised.map((domain) => ({
			name: domain.name,
			description: domain.description,
			...(domain.keywords ? { keywords: domain.keywords } : {}),
		}))

	const capabilityDomainDescriptionsByName = Object.fromEntries(
		advertised.map((domain) => [domain.name, domain.description]),
	) as Record<CapabilityDomain, string>

	const capabilityList = normalized.flatMap((domain) => domain.capabilities)
	const advertisedCapabilities = advertised.flatMap(
		(domain) => domain.capabilities,
	)
	const capabilityMap = createCapabilityMap(capabilityList)
	const capabilitySpecs = createCapabilitySpecs(advertisedCapabilities)
	const capabilityToolDescriptors = createCapabilityToolDescriptors(
		advertisedCapabilities,
	)
	const capabilityHandlers = Object.fromEntries(
		Object.entries(capabilityMap).map(([name, capability]) => [
			name,
			capability.handler,
		]),
	) as Record<string, Capability['handler']>

	return {
		capabilityList,
		capabilityDomains,
		capabilityDomainDescriptionsByName,
		capabilityMap,
		capabilitySpecs,
		capabilityToolDescriptors,
		capabilityHandlers,
	}
}

function createCapabilityMap(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) => [capability.name, capability] as const,
	)
	const seenNames = new Set<string>()
	const duplicateNames = new Set<string>()
	for (const [name] of entries) {
		if (seenNames.has(name)) {
			duplicateNames.add(name)
		} else {
			seenNames.add(name)
		}
	}
	if (duplicateNames.size > 0) {
		throw new Error(
			`Duplicate capability names: ${[...duplicateNames].join(', ')}`,
		)
	}
	return Object.fromEntries(entries) as Record<string, Capability>
}

function createCapabilitySpecs(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) =>
			[
				capability.name,
				{
					name: capability.name,
					domain: capability.domain,
					description: capability.description,
					keywords: capability.keywords,
					readOnly: capability.readOnly,
					idempotent: capability.idempotent,
					destructive: capability.destructive,
					orgPermission: capability.orgPermission,
					...(capability.requiredRole
						? { requiredRole: capability.requiredRole }
						: {}),
					...(capability.requiredPermission
						? { requiredPermission: capability.requiredPermission }
						: {}),
					...(capability.featureFlag
						? { featureFlag: capability.featureFlag }
						: {}),
					source: capability.source ?? 'builtin',
					...(capability.mcpServer ? { mcpServer: capability.mcpServer } : {}),
					inputFields: getSchemaPropertyNames(capability.inputSchema),
					requiredInputFields: getSchemaRequiredFields(capability.inputSchema),
					outputFields: capability.outputSchema
						? getSchemaPropertyNames(capability.outputSchema)
						: [],
					inputSchema: capability.inputSchema,
					...(capability.outputSchema
						? { outputSchema: capability.outputSchema }
						: {}),
					inputTypeDefinition: capability.inputTypeDefinition,
					...(capability.outputTypeDefinition
						? { outputTypeDefinition: capability.outputTypeDefinition }
						: {}),
				},
			] as const,
	)
	return Object.fromEntries(entries) as Record<string, CapabilitySpec>
}

function createCapabilityToolDescriptors(capabilities: Array<Capability>) {
	const entries = capabilities.map(
		(capability) =>
			[
				capability.name,
				{
					description: capability.description,
					inputSchema: capability.inputSchema,
					...(capability.outputSchema
						? { outputSchema: capability.outputSchema }
						: {}),
				},
			] as const,
	)
	return Object.fromEntries(entries) as JsonSchemaToolDescriptors
}

function getSchemaPropertyNames(schema: unknown) {
	const properties = getSchemaRecordProperty(schema, 'properties')
	if (properties && Object.keys(properties).length > 0) {
		return Object.keys(properties)
	}
	const variants = getSchemaObjectVariants(schema)
	return [
		...new Set(variants.flatMap((variant) => Object.keys(variant.properties))),
	]
}

function getSchemaRequiredFields(schema: unknown) {
	const required = getSchemaArrayProperty(schema, 'required')
	if (required) {
		return required.filter(
			(value): value is string => typeof value === 'string',
		)
	}
	const variants = getSchemaObjectVariants(schema)
	if (variants.length === 0) return []
	const requiredByVariant = variants.map((variant) => {
		const value = getSchemaArrayProperty(variant.schema, 'required')
		return new Set(
			value?.filter((entry): entry is string => typeof entry === 'string') ??
				[],
		)
	})
	return [...requiredByVariant[0]!].filter((field) =>
		requiredByVariant.every((fields) => fields.has(field)),
	)
}

function getSchemaObjectVariants(schema: unknown) {
	if (!schema || typeof schema !== 'object') return []
	const object = schema as Record<string, unknown>
	const variants = [object.oneOf, object.anyOf].find(Array.isArray)
	if (!variants) return []
	return variants.flatMap((variant) => {
		const properties = getSchemaRecordProperty(variant, 'properties')
		return properties ? [{ schema: variant, properties }] : []
	})
}

function getSchemaRecordProperty(schema: unknown, key: string) {
	if (!schema || typeof schema !== 'object') return null
	const value = (schema as Record<string, unknown>)[key]
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

function getSchemaArrayProperty(schema: unknown, key: string) {
	if (!schema || typeof schema !== 'object') return null
	const value = (schema as Record<string, unknown>)[key]
	return Array.isArray(value) ? value : null
}
