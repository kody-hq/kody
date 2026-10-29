import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	executeRoutingFromFlags,
	runRemoteExecuteWithToken,
} from '../src/remote-execute.js'

test('execute routing flags map to execute fields', () => {
	assert.equal(executeRoutingFromFlags({}), undefined)
	assert.deepEqual(
		executeRoutingFromFlags({
			context: ' studio ',
			fallback: 'chain',
			requires: 'fs, lan',
		}),
		{ context: 'studio', fallback: 'chain', requires: ['fs', 'lan'] },
	)
	assert.deepEqual(executeRoutingFromFlags({ chain: 'a,b,cloud' }), {
		chain: ['a', 'b', 'cloud'],
	})
	assert.throws(() => executeRoutingFromFlags({ fallback: 'cloud' }), /chain/)
})

test('remote execute sends routing fields in the body', async () => {
	let body: unknown
	await runRemoteExecuteWithToken({
		code: 'export default async () => 1',
		routing: { chain: ['a', 'cloud'], requires: ['fs'] },
		token: 'kody_at_test',
		apiUrl: 'https://kody.example/api',
		fetchFn: async (_url, init) => {
			body = JSON.parse(String(init?.body))
			return Response.json({ content: [{ type: 'text', text: '1' }] })
		},
	})
	assert.deepEqual((body as Record<string, unknown>).chain, ['a', 'cloud'])
	assert.deepEqual((body as Record<string, unknown>).requires, ['fs'])
})
