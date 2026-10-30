import { expect, test } from 'vitest'
import { grantPatchSchema } from './capabilities.ts'

test('executionContextUpdate rejects the removed grant.credentials field', () => {
	const result = grantPatchSchema.safeParse({ credentials: { mode: 'none' } })
	expect(result.success).toBe(false)
	expect(result.error?.issues.map((issue) => issue.message).join('\n')).toMatch(
		/grant\.credentials was removed/,
	)
})

test('executionContextUpdate still accepts a grant patch without credentials', () => {
	expect(
		grantPatchSchema.safeParse({ egress: { mode: 'public' } }).success,
	).toBe(true)
})
