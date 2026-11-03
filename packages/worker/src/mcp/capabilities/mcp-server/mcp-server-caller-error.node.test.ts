import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { personalOrgAccessD1 } from '#worker/test-support/org-binding-query.ts'
import type { McpServerSnapshot } from '#worker/mcp-client/types.ts'
import type * as McpClientStatus from '#worker/mcp-client/status.ts'

const mocks = vi.hoisted(() => ({
	callTool: vi.fn(),
	getMcpServerStatus: vi.fn(),
	assertCanUseMcpServer: vi.fn(),
}))

vi.mock('#worker/mcp-client/hub-client.ts', () => ({
	callMcpServerTool: ({
		serverId,
		toolName,
		args,
	}: {
		serverId: string
		toolName: string
		args: Record<string, unknown>
	}) => mocks.callTool({ serverId, toolName, args }),
}))

vi.mock('#worker/mcp-client/package-access.ts', async () => {
	const actual = await vi.importActual<
		typeof import('#worker/mcp-client/package-access.ts')
	>('#worker/mcp-client/package-access.ts')
	return {
		...actual,
		assertCanUseMcpServer: (...args: Array<unknown>) =>
			mocks.assertCanUseMcpServer(...args),
	}
})

vi.mock('#worker/mcp-client/status.ts', async () => {
	const actual = await vi.importActual<typeof McpClientStatus>(
		'#worker/mcp-client/status.ts',
	)
	return {
		...actual,
		getMcpServerStatus: (...args: Array<unknown>) =>
			mocks.getMcpServerStatus(...args),
	}
})

const { synthesizeMcpServerToolDomain } = await import('./index.ts')

const ref = { serverId: 'server-1', name: 'supermemory' }

function createSnapshot(): McpServerSnapshot {
	return {
		serverId: 'server-1',
		name: 'supermemory',
		url: 'https://mcp.example.com/mcp',
		state: 'ready',
		authorizationPending: false,
		error: null,
		instructions: null,
		tools: [
			{
				name: 'listMemories',
				description: 'List memories.',
				inputSchema: { type: 'object', properties: {} },
			},
		],
	}
}

function createContext() {
	return {
		env: {
			APP_DB: personalOrgAccessD1(),
			SENTRY_ENVIRONMENT: 'test',
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			user: {
				userId: personIdFromStored('user-alice'),
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}
}

test('mcp-server tool and availability failures throw McpCallerError', async () => {
	mocks.assertCanUseMcpServer.mockResolvedValue(undefined)
	mocks.callTool.mockRejectedValueOnce(
		new Error(
			"ProtocolError: Structured content does not match the tool's output schema",
		),
	)
	mocks.getMcpServerStatus.mockResolvedValueOnce({
		state: 'ready',
		serverId: 'server-1',
		name: 'supermemory',
		ready: true,
		toolCount: 1,
		message: 'connected',
		error: null,
	})

	const synthesized = synthesizeMcpServerToolDomain({
		ref,
		snapshot: createSnapshot(),
	})
	const capability = synthesized?.domain.capabilities[0]
	expect(capability).toBeDefined()

	const protocolError = await capability!.handler({}, createContext()).then(
		() => null,
		(thrown: unknown) => thrown,
	)

	expect(protocolError).toBeInstanceOf(McpCallerError)
	expect((protocolError as Error).message).toContain(
		'MCP server capability "supermemory:listMemories" failed:',
	)
	expect((protocolError as Error).message).toContain('Structured content')

	mocks.callTool.mockRejectedValueOnce(new Error('fetch failed'))
	mocks.getMcpServerStatus.mockResolvedValueOnce({
		state: 'disconnected',
		serverId: 'server-1',
		name: 'supermemory',
		ready: false,
		toolCount: 0,
		message: 'The MCP server "supermemory" is not connected.',
		error: null,
	})

	const disconnected = await capability!.handler({}, createContext()).then(
		() => null,
		(thrown: unknown) => thrown,
	)

	expect(disconnected).toBeInstanceOf(McpCallerError)
	expect((disconnected as Error).message).toMatch(/not connected/)

	mocks.assertCanUseMcpServer.mockRejectedValueOnce(
		new McpCallerError('package-locked'),
	)
	const denied = await capability!.handler({}, createContext()).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(McpCallerError)
	expect(mocks.callTool).toHaveBeenCalledTimes(2)

	mocks.callTool.mockResolvedValueOnce({
		content: Array.from({ length: 33 }, () => ({ type: 'text', text: 'x' })),
	})
	const rejected = await capability!.handler({}, createContext()).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(rejected).toBeInstanceOf(McpCallerError)
	expect((rejected as Error).message).toMatch(/too many MCP content blocks/)
	expect((rejected as Error).message).not.toContain(
		'MCP server capability "supermemory:listMemories" failed:',
	)
})
