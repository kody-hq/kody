import { test } from 'vitest'
import assert from 'node:assert/strict'
import { privateOriginFetch } from './private-smoke.ts'

test('private CLI adapter preserves same-origin session and prevents redirect credential forwarding', async () => {
	let calls = 0
	const transport: typeof fetch = async (_input, init) => {
		calls++
		const headers = new Headers(init?.headers)
		assert.equal(headers.get('Cookie'), 'session=test')
		assert.equal(headers.get('CF-Access-Client-Secret'), 'fixture-token')
		assert.equal(init?.redirect, 'manual')
		return new Response(null, {
			status: 302,
			headers: { Location: 'https://external.example.test/' },
		})
	}
	const request = privateOriginFetch(
		'https://private.example.test',
		{ 'CF-Access-Client-Secret': 'fixture-token' },
		transport,
	)
	await assert.rejects(
		request('https://private.example.test/account', {
			headers: { Cookie: 'session=test' },
		}),
		/refuses redirects/,
	)
	await assert.rejects(
		request('https://external.example.test/account'),
		/escaped/,
	)
	assert.equal(calls, 1)
})
