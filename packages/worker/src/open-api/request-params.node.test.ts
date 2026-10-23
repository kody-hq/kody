import { expect, test } from 'vitest'
import { readQueryParams } from './request-params.ts'

test('readQueryParams skips auth-reserved org so GET/DELETE keep strict schemas', () => {
	const params = readQueryParams(new URLSearchParams('org=team&limit=10'), {
		type: 'object',
		properties: {
			limit: { type: 'integer' },
		},
		additionalProperties: false,
		required: [],
	})
	expect(params).toEqual({ limit: 10 })
	expect(params).not.toHaveProperty('org')
})
