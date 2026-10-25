import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	classifyMcpProtocolRequest,
	recordMcpProtocolEvent,
	type McpProtocolEventEnv,
} from './protocol-metrics.ts'

const mcpUrl = 'https://example.com/mcp'

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
	return new Request(mcpUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...headers,
		},
		body: JSON.stringify(body),
	})
}

test('classifyMcpProtocolRequest covers legacy, modern, and failure paths', async () => {
	const initializeRequest = jsonRequest({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: '2025-06-18',
			capabilities: {},
			clientInfo: { name: 'claude-ai', version: '0.1.0' },
		},
	})
	expect(await classifyMcpProtocolRequest(initializeRequest)).toMatchObject({
		lane: 'legacy',
		method: 'initialize',
		protocolVersion: '2025-06-18',
		clientName: 'claude-ai',
		clientVersion: '0.1.0',
		packageIdentityParam: '',
	})
	// The request body stays readable for the lane that serves it.
	expect(await initializeRequest.text()).toContain('initialize')

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/call',
					params: { name: 'search', arguments: { query: 'email' } },
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({
		lane: 'legacy',
		method: 'tools/call',
		protocolVersion: '2025-03-26',
		clientName: '',
		clientVersion: '',
		packageIdentityParam: 'none',
	})

	const modern = await classifyMcpProtocolRequest(
		jsonRequest(
			{
				jsonrpc: '2.0',
				id: 3,
				method: 'tools/call',
				params: {
					name: 'search',
					arguments: { query: 'email' },
					_meta: {
						'io.modelcontextprotocol/protocolVersion': '2026-07-28',
						'io.modelcontextprotocol/clientCapabilities': {},
						'io.modelcontextprotocol/clientInfo': {
							name: 'modern-client',
							version: '2.0.0',
						},
					},
				},
			},
			{
				'MCP-Protocol-Version': '2026-07-28',
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'search',
			},
		),
	)
	expect(modern).toMatchObject({
		lane: 'modern',
		method: 'tools/call',
		protocolVersion: '2026-07-28',
		clientName: 'modern-client',
		clientVersion: '2.0.0',
		packageIdentityParam: 'none',
	})
	expect(modern.parsedBody).toMatchObject({ method: 'tools/call' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: {
						name: 'packageGet',
						arguments: { kody_id: 'notes' },
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'kody_id' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 5,
					method: 'tools/call',
					params: {
						name: 'packageGet',
						arguments: { package_id: 'pkg-1' },
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'package_id' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 6,
					method: 'tools/call',
					params: {
						name: 'repoResolve',
						arguments: {
							target: { kody_id: 'notes', package_id: 'pkg-1' },
						},
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'both' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 7,
					method: 'tools/call',
					params: {
						name: 'packageGet',
						arguments: { name: '@kentcdodds/notes' },
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'name' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 8,
					method: 'tools/call',
					params: {
						name: 'api',
						arguments: {
							operationId: 'packageGet',
							params: { kody_id: 'notes' },
						},
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'kody_id' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 8.1,
					method: 'tools/call',
					params: {
						name: 'webhookList',
						arguments: { kodyId: 'notes' },
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'kody_id' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 8.2,
					method: 'tools/call',
					params: {
						name: 'enablementEnable',
						arguments: { packageId: 'pkg-1', kodyId: 'notes' },
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'both' })

	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 8.3,
					method: 'tools/call',
					params: {
						name: 'api',
						arguments: {
							operationId: 'webhookList',
							params: { kodyId: 'notes' },
						},
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'kody_id' })

	// execute also has a params bag, but those are user-code inputs — not
	// package-identity aliases for the alias-retirement soak.
	expect(
		await classifyMcpProtocolRequest(
			jsonRequest(
				{
					jsonrpc: '2.0',
					id: 9,
					method: 'tools/call',
					params: {
						name: 'execute',
						arguments: {
							code: 'export default () => 1',
							params: { kody_id: 'not-a-package-alias' },
						},
					},
				},
				{ 'mcp-protocol-version': '2025-03-26' },
			),
		),
	).toMatchObject({ packageIdentityParam: 'none' })

	expect(
		await classifyMcpProtocolRequest(
			new Request(mcpUrl, {
				headers: {
					Accept: 'text/event-stream',
					'mcp-protocol-version': '2025-06-18',
				},
			}),
		),
	).toMatchObject({
		lane: 'legacy',
		method: 'http:GET',
		protocolVersion: '2025-06-18',
		packageIdentityParam: '',
	})
	expect(
		await classifyMcpProtocolRequest(new Request(mcpUrl, { method: 'DELETE' })),
	).toMatchObject({
		lane: 'legacy',
		method: 'http:DELETE',
		packageIdentityParam: '',
	})

	const invalid = await classifyMcpProtocolRequest(
		new Request(mcpUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		}),
	)
	expect(invalid.lane).toBe('legacy')
	expect(invalid.method).toBe('unknown')
	expect(invalid.packageIdentityParam).toBe('')
	expect(invalid.parsedBody).toBeUndefined()
})

const modernListEvent = {
	lane: 'modern',
	method: 'tools/list',
	protocolVersion: '2026-07-28',
	clientName: '',
	clientVersion: '',
	packageIdentityParam: '' as const,
} as const

test('recordMcpProtocolEvent writes a data point, no-ops without binding, and swallows sink errors', () => {
	const writeDataPoint = vi.fn<(point: AnalyticsEngineDataPoint) => void>()
	const env = {
		MCP_PROTOCOL_EVENTS: {
			writeDataPoint,
		} as unknown as AnalyticsEngineDataset,
	} satisfies McpProtocolEventEnv
	recordMcpProtocolEvent(env, {
		lane: 'legacy',
		method: 'tools/call',
		protocolVersion: '2025-06-18',
		clientName: 'claude-ai',
		clientVersion: '0.1.0',
		packageIdentityParam: 'kody_id',
		userId: ownerIdFromStored('user-1'),
		requestHost: 'kody.codes',
	})
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: ['legacy'],
		blobs: [
			'legacy',
			'tools/call',
			'2025-06-18',
			'claude-ai',
			'0.1.0',
			'user-1',
			'kody.codes',
			'kody_id',
		],
		doubles: [1],
	})

	expect(() => recordMcpProtocolEvent({}, modernListEvent)).not.toThrow()

	consoleWarn.mockImplementation(() => {})
	expect(() =>
		recordMcpProtocolEvent(
			{
				MCP_PROTOCOL_EVENTS: {
					writeDataPoint: () => {
						throw new Error('sink offline')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			modernListEvent,
		),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledWith(
		'mcp-protocol-event-failed',
		expect.any(Error),
	)
})
