import { expect, test } from 'vitest'
import { readJsonBody, readQueryParams } from './request-params.ts'

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

test('readJsonBody rejects an oversized chunked body without a Content-Length', async () => {
	const chunk = new Uint8Array(1024 * 1024).fill(0x20)
	let pulled = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += 1
			if (pulled > 64) controller.close()
			else controller.enqueue(chunk)
		},
	})
	const request = new Request('https://example.test/v1/x', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body,
		duplex: 'half',
	} as RequestInit)

	const result = await readJsonBody(request)

	expect(result.kind).toBe('too_large')
	expect(pulled).toBeLessThan(10)
})

test('readJsonBody parses a JSON object body', async () => {
	const result = await readJsonBody(
		new Request('https://example.test/v1/x', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'kody' }),
		}),
	)
	expect(result).toEqual({ kind: 'ok', body: { name: 'kody' } })
})
