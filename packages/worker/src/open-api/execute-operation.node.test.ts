import { expect, test } from 'vitest'
import { z } from 'zod'
import { executeHttpInputSchema } from './execute-operation.ts'

test('/v1/execute does not take invoke, so an invoke-only call has no code', () => {
	const jsonSchema = z.toJSONSchema(executeHttpInputSchema) as {
		properties: Record<string, unknown>
	}
	expect(jsonSchema.properties).toHaveProperty('code')
	expect(jsonSchema.properties).not.toHaveProperty('invoke')

	expect(
		executeHttpInputSchema.parse({
			invoke: 'kody:@acme/github/listRepos',
			params: {},
		}),
	).toEqual({ params: {} })
})
