import { expect, test } from 'vitest'
import { readJsonApiResponse } from './read-json-api-response.ts'

test('readJsonApiResponse surfaces empty non-JSON bodies instead of throwing', async () => {
	const empty = await readJsonApiResponse(
		new Response(null, {
			status: 405,
			headers: { Allow: 'GET, HEAD' },
		}),
	)
	expect(empty).toEqual({
		ok: false,
		status: 405,
		data: null,
		error: 'Request failed (405).',
	})

	const jsonError = await readJsonApiResponse(
		new Response(JSON.stringify({ ok: false, error: 'Unauthorized.' }), {
			status: 401,
			headers: { 'content-type': 'application/json' },
		}),
	)
	expect(jsonError).toEqual({
		ok: false,
		status: 401,
		data: { ok: false, error: 'Unauthorized.' },
		error: null,
	})

	const emptyJson = await readJsonApiResponse(
		new Response('', {
			status: 405,
			headers: { 'content-type': 'application/json' },
		}),
	)
	expect(emptyJson.ok).toBe(false)
	expect(emptyJson.data).toBeNull()
	expect(emptyJson.error).toMatch(/empty or invalid JSON/)
})
