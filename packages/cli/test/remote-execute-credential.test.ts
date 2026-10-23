import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runRemoteExecuteWithToken } from '../src/remote-execute.js'

test('runRemoteExecuteWithToken sends --credential on POST /v1/execute', async () => {
	let body: unknown
	await runRemoteExecuteWithToken({
		code: 'export default () => 1',
		token: 'kody_at_x',
		apiUrl: 'https://api.kody.codes',
		credentials: { github: 'work' },
		fetchFn: (async (_input, init) => {
			body = JSON.parse(String(init?.body))
			return new Response(
				JSON.stringify({
					content: [{ type: 'text', text: 'ok' }],
					isError: false,
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}) as typeof fetch,
	})
	assert.deepEqual(body, {
		code: 'export default () => 1',
		credentials: { github: 'work' },
	})
})
