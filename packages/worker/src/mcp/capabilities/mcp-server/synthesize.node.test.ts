import { expect, test } from 'vitest'
import { type McpServerSnapshot } from '#worker/mcp-client/types.ts'
import { synthesizeMcpServerToolDomain } from './index.ts'

test('synthesizes a ready server tool with its binding and access hint', () => {
	const ref = { serverId: 'server-1', name: 'linear' }
	const snapshot: McpServerSnapshot = {
		serverId: 'server-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		state: 'ready',
		authorizationPending: false,
		error: null,
		instructions: null,
		tools: [
			{
				name: 'list_issues',
				description: 'List issues.',
				inputSchema: { type: 'object', properties: {} },
				annotations: { readOnlyHint: true },
			},
		],
	}

	const synthesized = synthesizeMcpServerToolDomain({ ref, snapshot })
	expect(synthesized?.domain.name).toBe('mcp:linear')
	expect(synthesized?.domain.capabilities[0]?.name).toBe(
		'mcp:linear:list_issues',
	)
	expect(synthesized?.bindings['mcp:linear:list_issues']).toMatchObject({
		serverId: 'server-1',
		mcpToolName: 'list_issues',
	})
	expect(
		synthesizeMcpServerToolDomain({
			ref,
			snapshot: { ...snapshot, state: 'authenticating', tools: [] },
		}),
	).toBeNull()
})
