import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeHostDocument } from '../src/host-config.js'

const mcpUrl = 'https://kody.codes/mcp'

test('mergeHostDocument writes leftover-host remote entries and keeps siblings', () => {
	const insiders = mergeHostDocument({
		id: 'vscode-insiders',
		existing: JSON.stringify({
			servers: { other: { url: 'https://example.test' } },
		}),
		mcpUrl,
	})
	assert.equal(insiders.changed, true)
	assert.deepEqual(JSON.parse(insiders.body), {
		servers: {
			other: { url: 'https://example.test' },
			kody: { type: 'http', url: mcpUrl },
		},
	})

	const amazonQ = mergeHostDocument({ id: 'amazon-q', existing: null, mcpUrl })
	assert.deepEqual(JSON.parse(amazonQ.body), {
		mcpServers: { kody: { type: 'http', url: mcpUrl } },
	})

	const qwen = mergeHostDocument({
		id: 'qwen-code',
		existing: '{"theme":"dark"}',
		mcpUrl,
	})
	assert.deepEqual(JSON.parse(qwen.body), {
		theme: 'dark',
		mcpServers: { kody: { httpUrl: mcpUrl } },
	})
})

test('mergeHostDocument is idempotent when the URL already matches', () => {
	const first = mergeHostDocument({
		id: 'vscode-insiders',
		existing: null,
		mcpUrl,
	})
	const second = mergeHostDocument({
		id: 'vscode-insiders',
		existing: first.body,
		mcpUrl,
	})
	assert.equal(second.changed, false)
})
