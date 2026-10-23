import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	getCapabilityRegistryForContext,
	getStaticRegistry,
} from '#mcp/capabilities/registry.ts'
import * as hubClient from '#worker/mcp-client/hub-client.ts'
import * as settingsService from '#worker/mcp-client/settings-service.ts'
import { mcpServerCapabilityId } from '#worker/mcp-client/mcp-domain-id.ts'

const personId = personIdFromStored('b'.repeat(64))
const teamOrgId = ownerIdFromStored('c'.repeat(64))
const teamServerId = 'mcp-server-team-1'
const teamServerName = 'exa'
const teamToolName = 'web_search'

afterEach(() => {
	vi.restoreAllMocks()
})

test('getCapabilityRegistryForContext filters admin capabilities by current caller roles', async () => {
	const env = {} as Env
	const adminContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'admin@example.com',
			displayName: 'admin',
			roles: ['admin'],
		},
	})
	const regularContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'admin@example.com',
			displayName: 'admin',
			roles: ['user'],
		},
	})

	const adminRegistry = await getCapabilityRegistryForContext({
		env,
		callerContext: adminContext,
	})
	const regularRegistry = await getCapabilityRegistryForContext({
		env,
		callerContext: regularContext,
	})

	expect(adminRegistry.capabilityMap.adminUserList).toBeDefined()
	expect(
		adminRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(true)
	expect(regularRegistry.capabilityMap.adminUserList).toBeUndefined()
	expect(
		regularRegistry.capabilityDomains.some((domain) => domain.name === 'admin'),
	).toBe(false)
})

test('member, role, and invite changes need a live person; site-admin tools do not', async () => {
	const registry = await getStaticRegistry()
	const missing = registry.capabilityList
		.filter(
			(capability) =>
				(capability.orgPermission === 'member:write' ||
					capability.orgPermission === 'member:delete') &&
				capability.requiresLivePerson === 'never',
		)
		.map((capability) => capability.name)
	expect(missing).toEqual([])
	const gatedSiteAdmin = registry.capabilityList
		.filter(
			(capability) =>
				(capability.requiredRole ||
					capability.requiredPermission ||
					capability.domain === 'admin') &&
				capability.requiresLivePerson !== 'never',
		)
		.map((capability) => capability.name)
	expect(gatedSiteAdmin).toEqual([])
})

test('getCapabilityRegistryForContext synthesizes MCP tools for the bound org, not the personal org', async () => {
	const env = {} as Env
	const requestedOwnerIds: Array<string> = []
	vi.spyOn(
		settingsService,
		'listEnabledMcpServerRefsCached',
	).mockImplementation(async (input) => {
		requestedOwnerIds.push(input.userId)
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

	const teamBound = createMcpCallerContext({
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
	})
	const personalBound = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.example',
		user: {
			userId: personId,
			email: 'brad@example.com',
			displayName: 'brad',
			roles: ['user'],
		},
	})

	const teamRegistry = await getCapabilityRegistryForContext({
		env,
		callerContext: teamBound,
	})
	const personalRegistry = await getCapabilityRegistryForContext({
		env,
		callerContext: personalBound,
	})

	const capabilityName = mcpServerCapabilityId({
		ref: { name: teamServerName },
		toolName: teamToolName,
	})
	expect(requestedOwnerIds).toContain(teamOrgId)
	expect(requestedOwnerIds).toContain(personId)
	expect(teamRegistry.capabilityMap[capabilityName]).toBeTruthy()
	expect(teamRegistry.capabilityMap[capabilityName]?.source).toBe('mcp-server')
	expect(personalRegistry.capabilityMap[capabilityName]).toBeUndefined()
})
