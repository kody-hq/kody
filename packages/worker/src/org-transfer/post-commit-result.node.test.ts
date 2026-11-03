import { expect, test } from 'vitest'
import type { McpHubConnectResult } from '#worker/mcp-client/types.ts'
import { describeOrgTransferMcpConnection } from './post-commit-result.ts'

function connectResult(
	overrides: Partial<McpHubConnectResult>,
): McpHubConnectResult {
	return {
		serverId: 'server-1',
		state: 'ready',
		authUrl: null,
		error: null,
		toolCount: 3,
		...overrides,
	}
}

const base = {
	serverId: 'server-1',
	name: 'linear',
	sourceRemoved: true,
	appOrigin: 'https://kody.example',
	toSlug: 'haveman',
}

test('a server awaiting approval links the Kody consent page, never the provider', () => {
	const connection = describeOrgTransferMcpConnection({
		...base,
		result: connectResult({
			state: 'authenticating',
			authUrl: 'https://provider.example/authorize?client_id=abc&state=xyz',
		}),
	})
	expect(connection).toEqual({
		id: 'server-1',
		name: 'linear',
		source_removed: true,
		state: 'authenticating',
		needs_authorization: true,
		authorize_url:
			'https://kody.example/@haveman/-/mcp-servers/server-1/authorize',
	})
	expect(JSON.stringify(connection)).not.toContain('provider.example')
})

test('a ready server needs nothing, and a failed connect step has no state', () => {
	expect(
		describeOrgTransferMcpConnection({ ...base, result: connectResult({}) }),
	).toEqual({
		id: 'server-1',
		name: 'linear',
		source_removed: true,
		state: 'ready',
		needs_authorization: false,
		authorize_url: null,
	})
	expect(describeOrgTransferMcpConnection({ ...base, result: null })).toEqual({
		id: 'server-1',
		name: 'linear',
		source_removed: true,
		state: null,
		needs_authorization: false,
		authorize_url: null,
	})
})
