import { expect, test } from 'vitest'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'

import { formatEntityDetailMarkdown, parseEntityRef } from './search-format.ts'
import {
	buildMcpServerToolIndex,
	findSynthesizedMcpServer,
	findWrappingPackageForMcpServer,
	listSynthesizedMcpServers,
} from './search-mcp-servers.ts'
import { searchUnified } from './search.ts'
import { type PackageSearchRow } from './search-types.ts'

function createHomeRegistry() {
	const homeServer = {
		serverId: 'server-home',
		serverName: 'home',
		kodyName: 'home',
	}
	return buildCapabilityRegistry([
		{
			name: 'mcp:home',
			description: 'Use set_pin after unlocking the island router.',
			capabilities: [
				{
					name: 'mcp:home:set_pin',
					orgPermission: 'none',
					contextRuns: 'deny',
					requiresLivePerson: 'never',
					domain: 'mcp:home',
					description: 'Set the island router PIN.',
					keywords: ['pin'],
					readOnly: false,
					idempotent: true,
					destructive: false,
					source: 'mcp-server',
					mcpServer: {
						...homeServer,
						mcpToolName: 'island.router.api/set-pin',
						toolName: 'set_pin',
					},
					inputSchema: { type: 'object', properties: {} },
					inputTypeDefinition: 'type SetPinInput = Record<string, never>',
					handler: async () => null,
				},
				{
					name: 'mcp:home:list_lights',
					orgPermission: 'none',
					contextRuns: 'deny',
					requiresLivePerson: 'never',
					domain: 'mcp:home',
					description: 'List lights.',
					keywords: ['lights'],
					readOnly: true,
					idempotent: true,
					destructive: false,
					source: 'mcp-server',
					mcpServer: {
						...homeServer,
						mcpToolName: 'list_lights',
						toolName: 'list_lights',
					},
					inputSchema: { type: 'object', properties: {} },
					inputTypeDefinition: 'type ListLightsInput = Record<string, never>',
					handler: async () => null,
				},
			],
		},
	])
}

test('MCP server entities resolve by name or domain and list tools with instructions', () => {
	expect(parseEntityRef('mcp-server:home')).toEqual({
		id: 'home',
		type: 'mcp-server',
	})
	expect(parseEntityRef('mcp-server:mcp:home')).toEqual({
		id: 'mcp:home',
		type: 'mcp-server',
	})

	const registry = createHomeRegistry()
	const servers = listSynthesizedMcpServers(registry)
	expect(servers).toHaveLength(1)
	expect(findSynthesizedMcpServer(servers, 'home')?.kodyName).toBe('home')
	expect(findSynthesizedMcpServer(servers, 'mcp:home')?.domain).toBe('mcp:home')
	expect(findSynthesizedMcpServer(servers, 'missing')).toBeNull()

	const [server] = servers
	expect(server).toMatchObject({
		kodyName: 'home',
		instructions: 'Use set_pin after unlocking the island router.',
	})
	const tools = buildMcpServerToolIndex(server!)
	expect(tools.map((tool) => tool.toolName)).toEqual(['set_pin', 'list_lights'])
	expect(
		findWrappingPackageForMcpServer(server!, [
			{
				record: {
					kodyId: 'notes',
					name: '@user/notes',
					tags: ['mcp'],
				},
			} as PackageSearchRow,
		]),
	).toBeNull()
	expect(
		findWrappingPackageForMcpServer(server!, [
			{
				record: {
					kodyId: 'home',
					name: '@user/home',
					tags: ['home'],
				},
			} as PackageSearchRow,
		]),
	).toMatchObject({ kodyId: 'home' })

	const detail = formatEntityDetailMarkdown({
		type: 'mcp-server',
		id: 'home',
		title: 'home',
		description: server!.description,
		domain: server!.domain,
		kodyName: server!.kodyName,
		serverName: server!.serverName,
		serverId: server!.serverId,
		instructions: server!.instructions,
		usage: server!.usage,
		tools,
		wrappingPackage: null,
	})
	expect(detail.markdown).toContain('# MCP server — `home`')
	expect(detail.markdown).toContain(
		'Use set_pin after unlocking the island router.',
	)
	expect(detail.markdown).toContain('mcp-server:home')
	expect(detail.markdown).toContain('capability:mcp:home:set_pin')
	expect(detail.markdown).toContain('kody.mcp["home"].set_pin(args)')
	expect(detail.structured).toMatchObject({
		type: 'mcp-server',
		entityRef: 'mcp-server:home',
		capabilityCount: 2,
		instructions: 'Use set_pin after unlocking the island router.',
	})
})

test('unscoped search ranks the MCP server instead of dumping every remote tool', async () => {
	const homeServer = {
		serverId: 'server-home',
		serverName: 'home',
		kodyName: 'home',
	}
	const toolNames = [
		'set_pin',
		'get_pin',
		'list_lights',
		'set_light',
		'get_thermostat',
		'set_thermostat',
		'lock_door',
		'unlock_door',
		'screenshot',
		'run_script',
		...Array.from({ length: 20 }, (_, index) => `home_tool_${String(index)}`),
	]
	const registry = buildCapabilityRegistry([
		{
			name: 'mcp:home',
			description:
				'Control lights, locks, and the island router PIN on the home LAN.',
			keywords: ['mcp', 'integration'],
			capabilities: toolNames.map((toolName) => ({
				name: `mcp:home:${toolName}`,
				domain: 'mcp:home',
				description:
					toolName === 'set_pin'
						? 'Set the island router PIN.'
						: `Home automation tool ${toolName}.`,
				keywords: ['home', toolName.replaceAll('_', ' ')],
				readOnly: false,
				idempotent: false,
				destructive: false,
				orgPermission: 'none',
				contextRuns: 'deny',
				requiresLivePerson: 'never',
				source: 'mcp-server' as const,
				mcpServer: {
					...homeServer,
					mcpToolName: toolName,
					toolName,
				},
				inputSchema: { type: 'object' as const, properties: {} },
				inputTypeDefinition: 'type HomeToolInput = Record<string, never>',
				handler: async () => null,
			})),
		},
	])
	const optionalRows = {
		packageRows: [],
		userSecretRows: [],
		userIntegrationRows: [],
	}

	const unscopedHome = await searchUnified({
		env: {} as Env,
		query: 'home',
		limit: 15,
		registry,
		optionalRows,
	})
	expect(
		unscopedHome.matches.filter((match) => match.type === 'capability'),
	).toEqual([])
	expect(
		unscopedHome.matches.filter((match) => match.type === 'mcp-server'),
	).toEqual([
		expect.objectContaining({
			type: 'mcp-server',
			kodyName: 'home',
			domain: 'mcp:home',
			capabilityCount: toolNames.length,
			instructions:
				'Control lights, locks, and the island router PIN on the home LAN.',
		}),
	])
	expect(unscopedHome.guidance).toContain('mcp-server:home')

	const unscopedPin = await searchUnified({
		env: {} as Env,
		query: 'set pin',
		limit: 15,
		registry,
		optionalRows,
	})
	expect(
		unscopedPin.matches.filter((match) => match.type === 'capability'),
	).toEqual([])
	expect(unscopedPin.matches.some((match) => match.type === 'mcp-server')).toBe(
		true,
	)

	const domainListing = await searchUnified({
		env: {} as Env,
		query: '',
		limit: 50,
		domain: 'mcp:home',
		registry,
		optionalRows,
	})
	expect(
		domainListing.matches.filter((match) => match.type === 'capability'),
	).toHaveLength(toolNames.length)
})
