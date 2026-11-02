import { expect, test } from 'vitest'
import { readRequestBodyUpTo } from './read-request-body-up-to.ts'

function chunkedRequest(
	chunks: Array<Uint8Array>,
	headers: Record<string, string> = {},
) {
	let pulled = 0
	let cancelled = false
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				const chunk = chunks[pulled]
				if (!chunk) {
					controller.close()
					return
				}
				pulled += 1
				controller.enqueue(chunk)
			},
			cancel() {
				cancelled = true
			},
		},
		{ highWaterMark: 0 },
	)
	const request = new Request('https://example.test/', {
		method: 'POST',
		headers,
		body,
		duplex: 'half',
	} as RequestInit)
	return {
		request,
		pulled: () => pulled,
		cancelled: () => cancelled,
	}
}

test('readRequestBodyUpTo stops reading a chunked body once it passes the cap', async () => {
	const chunk = new Uint8Array(1024)
	const source = chunkedRequest(Array.from({ length: 100 }, () => chunk))
	expect(source.request.headers.get('Content-Length')).toBeNull()

	const result = await readRequestBodyUpTo(source.request, 4096)

	expect(result).toEqual({ ok: false, byteLength: 5120 })
	expect(source.pulled()).toBeLessThan(10)
	expect(source.cancelled()).toBe(true)
})

test('readRequestBodyUpTo refuses a declared Content-Length over the cap without reading', async () => {
	const source = chunkedRequest([new Uint8Array(16)], {
		'Content-Length': '999999',
	})

	expect(await readRequestBodyUpTo(source.request, 4096)).toEqual({
		ok: false,
		byteLength: 999999,
	})
	expect(source.pulled()).toBe(0)
})

test('readRequestBodyUpTo returns the whole body at or under the cap', async () => {
	const source = chunkedRequest([
		new TextEncoder().encode('hello '),
		new TextEncoder().encode('world'),
	])

	const result = await readRequestBodyUpTo(source.request, 11)

	expect(result.ok).toBe(true)
	if (!result.ok) return
	expect(new TextDecoder().decode(result.bytes)).toBe('hello world')
})

test('readRequestBodyUpTo returns empty bytes for a bodyless request', async () => {
	const result = await readRequestBodyUpTo(
		new Request('https://example.test/', { method: 'POST' }),
		10,
	)
	expect(result).toEqual({ ok: true, bytes: new Uint8Array() })
})
