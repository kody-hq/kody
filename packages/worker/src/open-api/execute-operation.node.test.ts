import { expect, test } from 'vitest'
import { z } from 'zod'
import { hasRemovedExecuteInvoke } from '#mcp/execute-invoke-removed.ts'
import { executeHttpInputSchema } from './execute-operation.ts'

test('/v1/execute no longer advertises invoke but still sees legacy callers', () => {
	const jsonSchema = z.toJSONSchema(executeHttpInputSchema) as {
		properties: Record<string, unknown>
	}
	expect(jsonSchema.properties).toHaveProperty('code')
	expect(jsonSchema.properties).not.toHaveProperty('invoke')

	const legacy = { invoke: 'kody:@acme/github/listRepos', params: {} }
	expect(executeHttpInputSchema.safeParse(legacy).success).toBe(true)
	expect(hasRemovedExecuteInvoke(legacy)).toBe(true)
})
