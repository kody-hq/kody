import { expect, test } from 'vitest'
import { z } from 'zod'
import { runListInputSchema } from './run-list.ts'

test('runList rejects unknown keys and suggests supported snake_case filters', () => {
	const result = runListInputSchema.safeParse({
		surface: 'webhook',
		errorTriage: 'all',
		name: 'wake',
		packageId: 'pkg-1',
		limit: 5,
	})
	expect(result.success).toBe(false)
	if (result.success) return
	const message = z.prettifyError(result.error)
	expect(message).toContain(
		'errorTriage is not a parameter; did you mean error_triage?',
	)
	expect(message).toContain('name is not a parameter')
	expect(message).toContain(
		'packageId is not a parameter; did you mean package_id?',
	)
})
