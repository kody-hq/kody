import { expect, test } from 'vitest'
import { highlightCacheHeaderName } from '../../worker/universal/highlight-cache-header.ts'
import handler from './index.ts'

test('highlight worker returns tokens and a cache header', async () => {
	const response = await handler.fetch(
		new Request('https://highlight.internal/highlight', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				snippets: [{ code: 'const x = 1', lang: 'ts' }],
			}),
		}),
		{},
	)
	expect(response.status).toBe(200)
	const body = (await response.json()) as {
		results: Array<{ code: string; plain: boolean }>
	}
	expect(body.results).toHaveLength(1)
	expect(body.results[0]?.code).toBe('const x = 1')
	expect(body.results[0]?.plain).toBe(false)
	expect(response.headers.get(highlightCacheHeaderName)).toBe('miss')
})

function highlightRequest(url: string, snippets: Array<unknown>) {
	return new Request(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ snippets }),
	})
}

test('highlight worker refuses /highlight on public hostnames but keeps /health', async () => {
	const publicResponse = await handler.fetch(
		highlightRequest('https://kody-highlight.example.workers.dev/highlight', [
			{ code: 'const x = 1', lang: 'ts' },
		]),
		{},
	)
	expect(publicResponse.status).toBe(404)

	const health = await handler.fetch(
		new Request('https://kody-highlight.example.workers.dev/health'),
		{ APP_COMMIT_SHA: 'abc' },
	)
	expect(health.status).toBe(200)
	expect(await health.json()).toEqual({ ok: true, commit: 'abc' })
})

test('highlight worker rejects oversized snippet batches', async () => {
	const tooMany = await handler.fetch(
		highlightRequest(
			'https://highlight.internal/highlight',
			Array.from({ length: 1_001 }, () => ({ code: 'x', lang: 'ts' })),
		),
		{},
	)
	expect(tooMany.status).toBe(413)

	const tooLarge = await handler.fetch(
		highlightRequest(
			'https://highlight.internal/highlight',
			Array.from({ length: 41 }, () => ({ code: 'x'.repeat(50_000) })),
		),
		{},
	)
	expect(tooLarge.status).toBe(413)
})
