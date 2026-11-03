import { expect, test } from 'vitest'
import { createSchemaTypeDefinition } from './schema-type-definitions.ts'
import type { CapabilityJsonSchema } from './types.ts'

test('createSchemaTypeDefinition composes intersections and escapes schema comment markers', () => {
	const intersected = createSchemaTypeDefinition({
		typeName: 'IntersectedInput',
		jsonSchema: {
			allOf: [
				{
					anyOf: [{ type: 'string' }, { type: 'number' }],
				},
				{
					type: 'object',
					properties: {
						id: { type: 'string' },
					},
					required: ['id'],
				},
			],
		} as CapabilityJsonSchema,
	})
	expect(intersected).toMatch(/string \| number/)

	const commented = createSchemaTypeDefinition({
		typeName: 'CreateIssueInput',
		jsonSchema: {
			type: 'object',
			description: 'Root description.',
			properties: {
				owner: {
					type: 'string',
					description: 'Owner field.',
				},
				repo: {
					type: 'string',
					description: 'First line.\nSecond line.',
				},
				body: {
					type: 'string',
					description: 'Closing marker */ should stay escaped.',
				},
			},
			required: ['owner', 'repo'],
		} as CapabilityJsonSchema,
	})

	expect(commented).not.toMatch(/Closing marker \*\/ should/)
	expect(commented).toMatch(/Closing marker \* \/ should/)
})
