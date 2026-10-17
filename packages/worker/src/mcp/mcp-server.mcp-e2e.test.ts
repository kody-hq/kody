import { expect, test } from 'vitest'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	createMcpClient,
	createUniqueTestUser,
	getSharedMcpE2eServer,
} from '../../../../tools/mcp-test-support.ts'

/**
 * MCP E2E is intentionally tiny.
 *
 * Do not add cases here unless the thing being tested genuinely requires the
 * real MCP HTTP transport and OAuth flow all at once. Most capability behavior
 * belongs in faster node/workers tests beside the implementation. Keep this
 * file to a couple of smoke journeys.
 */

test('mcp endpoint requires OAuth bearer auth', async () => {
	const server = await getSharedMcpE2eServer()

	const response = await fetch(new URL('/mcp', server.origin), {
		headers: {
			Accept: 'application/json, text/event-stream',
		},
	})

	expect(response.status).toBe(401)
	const authenticateHeader = response.headers.get('WWW-Authenticate') ?? ''
	expect(authenticateHeader).toMatch(/^Bearer\s+/)
})

test('authenticated MCP search shows admin capabilities only to admin users', async () => {
	const server = await getSharedMcpE2eServer()
	const regularUser = createUniqueTestUser()
	await using regularClient = await createMcpClient(
		server.origin,
		regularUser,
		{
			ensureUser: server.ensureUser,
			markEmailVerified: server.markEmailVerified,
			clearAuthRateLimits: server.clearAuthRateLimits,
		},
	)

	const regularSearch = await regularClient.client.callTool({
		name: 'search',
		arguments: {
			query: 'admin users roles audit',
			limit: 10,
		},
	})
	expect(searchMatchIds(regularSearch)).not.toContain('adminUserList')

	const adminUser = createUniqueTestUser()
	await using bootstrapClient = await createMcpClient(
		server.origin,
		adminUser,
		{
			ensureUser: server.ensureUser,
			markEmailVerified: server.markEmailVerified,
			clearAuthRateLimits: server.clearAuthRateLimits,
		},
	)
	void bootstrapClient
	await server.assignRole(adminUser.email, 'admin')
	await using adminClient = await createMcpClient(server.origin, adminUser, {
		ensureUser: server.ensureUser,
		markEmailVerified: server.markEmailVerified,
		clearAuthRateLimits: server.clearAuthRateLimits,
	})

	// Role was written through the live harness D1. Auth and the capability
	// registry load roles per request (`request-auth-cache` is a WeakMap;
	// registry cache is not keyed by role). Poll until the grant is visible
	// the same way production would observe a freshly assigned role.
	await expect
		.poll(
			async () => {
				const adminSearch = await adminClient.client.callTool({
					name: 'search',
					arguments: {
						// Exact-ish capability name so ranking stays stable as
						// the admin catalog grows (limit 10 is otherwise brittle).
						query: 'adminUserList',
						limit: 10,
					},
				})
				return searchMatchIds(adminSearch)
			},
			{ timeout: 10_000, interval: 250 },
		)
		.toContain('adminUserList')
})

function searchMatchIds(result: unknown) {
	return (
		(
			(result as CallToolResult).structuredContent as {
				result?: { matches?: Array<{ id?: string }> }
			}
		)?.result?.matches ?? []
	).flatMap((match) => (typeof match.id === 'string' ? [match.id] : []))
}
