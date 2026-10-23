import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { mcpServerCapabilityId } from '#worker/mcp-client/mcp-domain-id.ts'
import * as hubClient from '#worker/mcp-client/hub-client.ts'
import * as settingsService from '#worker/mcp-client/settings-service.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'

const personId = personIdFromStored('b'.repeat(64))
const teamOrgId = ownerIdFromStored('c'.repeat(64))
const teamServerId = 'mcp-server-team-1'
const teamServerName = 'exa'
const teamToolName = 'web_search'

afterEach(() => {
	vi.restoreAllMocks()
})

test('metaListCapabilities keeps team MCP tools when visibility uses the bound org', async () => {
	const env = {} as Env
	const visibilityOwnerIds: Array<string> = []
	vi.spyOn(
		settingsService,
		'listEnabledMcpServerRefsCached',
	).mockImplementation(async (input) => {
		if (input.userId !== teamOrgId) return []
		return [
			{
				serverId: teamServerId,
				name: teamServerName,
				usageMode: 'any',
				allowedPackageIds: [],
			},
		]
	})
	vi.spyOn(
		settingsService,
		'listVisibleEnabledMcpServerRefsCached',
	).mockImplementation(async (input) => {
		visibilityOwnerIds.push(input.userId)
		if (input.userId !== teamOrgId) return []
		return [
			{
				serverId: teamServerId,
				name: teamServerName,
				usageMode: 'any',
				allowedPackageIds: [],
			},
		]
	})
	vi.spyOn(hubClient, 'getCachedMcpClientHubSnapshot').mockImplementation(
		async (input) => {
			if (input.userId !== teamOrgId) {
				return { servers: [] }
			}
			return {
				servers: [
					{
						serverId: teamServerId,
						name: teamServerName,
						url: 'https://mcp.exa.ai/mcp',
						state: 'ready' as const,
						tools: [
							{
								name: teamToolName,
								description: 'Search the web',
								inputSchema: { type: 'object', properties: {} },
							},
						],
						error: null,
						lastError: null,
						instructions: null,
						hasRefreshToken: true,
						authorizationPending: false,
					},
				],
			}
		},
	)

	const capabilityName = mcpServerCapabilityId({
		ref: { name: teamServerName },
		toolName: teamToolName,
	})
	const result = await metaListCapabilitiesCapability.handler(
		{ domain: `mcp:${teamServerName}` },
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.example',
				user: {
					userId: personId,
					email: 'brad@example.com',
					displayName: 'brad',
					roles: ['user'],
				},
				orgBinding: {
					org: { id: teamOrgId, slug: 'haveman' },
					role: 'owner',
				},
			}),
		},
	)

	expect(visibilityOwnerIds).toEqual([teamOrgId])
	expect(
		result.capabilities?.some(
			(capability) => capability.name === capabilityName,
		),
	).toBe(true)
})
