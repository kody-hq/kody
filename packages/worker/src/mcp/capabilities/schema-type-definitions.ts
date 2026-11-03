import { isRecord } from '@kody-internal/shared/is-record.ts'
import type { CapabilityJsonSchema } from './types.ts'

type TypeDefinitionOptions = {
	jsonSchema: CapabilityJsonSchema
	typeName: string
}

export function createCapabilityTypeName(
	capabilityName: string,
	suffix: 'Input' | 'Output',
) {
	const pascalName = capabilityName
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join('')
	const safeName = pascalName || 'Capability'
	return `${/^[A-Za-z_$]/.test(safeName) ? safeName : `Capability${safeName}`}${suffix}`
}

export function createSchemaTypeDefinition({
	jsonSchema,
	typeName,
}: TypeDefinitionOptions) {
	return createJsonSchemaTypeDefinition(jsonSchema, typeName)
}

function createJsonSchemaTypeDefinition(
	schema: CapabilityJsonSchema,
	typeName: string,
) {
	const description = isRecord(schema) ? readDescription(schema) : undefined
	const comment = description ? `${formatComment(description)}\n` : ''
	return `${comment}type ${typeName} = ${jsonSchemaToType(schema)}`
}

function jsonSchemaToType(schema: unknown): string {
	if (schema === true) return 'unknown'
	if (schema === false) return 'never'
	if (!isRecord(schema)) return 'unknown'

	if ('const' in schema) return literalToType(schema.const)
	if (Array.isArray(schema.enum)) {
		return (
			schema.enum.map((value) => literalToType(value)).join(' | ') || 'never'
		)
	}
	if (Array.isArray(schema.anyOf)) {
		return joinSchemaTypes(schema.anyOf, ' | ')
	}
	if (Array.isArray(schema.oneOf)) {
		return joinSchemaTypes(schema.oneOf, ' | ')
	}
	if (Array.isArray(schema.allOf)) {
		return joinSchemaTypes(schema.allOf, ' & ')
	}
	if (Array.isArray(schema.type)) {
		return schema.type
			.map((type) => jsonSchemaToType({ ...schema, type }))
			.join(' | ')
	}

	switch (schema.type) {
		case 'string':
			return 'string'
		case 'number':
		case 'integer':
			return 'number'
		case 'boolean':
			return 'boolean'
		case 'null':
			return 'null'
		case 'array':
			return arraySchemaToType(schema)
		case 'object':
			return objectSchemaToType(schema)
		default:
			if (isRecord(schema.properties)) return objectSchemaToType(schema)
			if ('items' in schema) return arraySchemaToType(schema)
			return 'unknown'
	}
}

function joinSchemaTypes(schemas: Array<unknown>, separator: ' | ' | ' & ') {
	const types = schemas.map((subschema) => {
		const type = jsonSchemaToType(subschema)
		return separator === ' & ' ? parenthesizeUnion(type) : type
	})
	if (types.length === 0) return 'never'
	return types.join(separator)
}

function parenthesizeUnion(type: string) {
	return type.includes(' | ') ? `(${type})` : type
}

function arraySchemaToType(schema: Record<string, unknown>) {
	if (Array.isArray(schema.items)) {
		return `[${schema.items.map((item) => jsonSchemaToType(item)).join(', ')}]`
	}
	return `Array<${jsonSchemaToType(schema.items)}>`
}

function objectSchemaToType(schema: Record<string, unknown>) {
	const properties = isRecord(schema.properties) ? schema.properties : {}
	const propertyEntries = Object.entries(properties)
	const required = new Set(
		Array.isArray(schema.required)
			? schema.required.filter(
					(value): value is string => typeof value === 'string',
				)
			: [],
	)
	const additionalProperties = schema.additionalProperties

	if (propertyEntries.length === 0) {
		if (additionalProperties === false) return 'Record<string, never>'
		if (isRecord(additionalProperties)) {
			return `Record<string, ${jsonSchemaToType(additionalProperties)}>`
		}
		return 'Record<string, unknown>'
	}

	const lines = propertyEntries.map(([name, propertySchema]) => {
		const optional = required.has(name) ? '' : '?'
		const propertyDescription = isRecord(propertySchema)
			? readDescription(propertySchema)
			: undefined
		return [
			...(propertyDescription
				? [formatComment(propertyDescription, { indent: '\t' })]
				: []),
			`\t${formatPropertyName(name)}${optional}: ${jsonSchemaToType(propertySchema)}`,
		].join('\n')
	})
	if (isRecord(additionalProperties)) {
		lines.push(`\t[key: string]: ${jsonSchemaToType(additionalProperties)}`)
	}

	return `{\n${lines.join('\n')}\n}`
}

function formatPropertyName(name: string) {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

function literalToType(value: unknown): string {
	switch (typeof value) {
		case 'string':
			return JSON.stringify(value)
		case 'number':
		case 'boolean':
			return String(value)
		default:
			return value === null ? 'null' : 'unknown'
	}
}

function readDescription(schema: Record<string, unknown>) {
	const description = schema.description
	return typeof description === 'string' && description.trim()
		? description.trim()
		: undefined
}

function formatComment(
	description: string,
	options?: {
		indent?: string
	},
) {
	const indent = options?.indent ?? ''
	const lines = description
		.replaceAll('*/', '* /')
		.split(/\r?\n/)
		.map((line) => line.trim())
	if (lines.length === 1) {
		return `${indent}/** ${lines[0]} */`
	}
	return [
		`${indent}/**`,
		...lines.map((line) => `${indent} * ${line}`),
		`${indent} */`,
	].join('\n')
}
