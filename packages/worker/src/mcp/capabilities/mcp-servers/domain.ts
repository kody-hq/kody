import { defineDomain } from '#mcp/capabilities/define-domain.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { mcpServerAddCapability } from './mcp-server-add.ts'
import { mcpServerListCapability } from './mcp-server-list.ts'
import { mcpServerReconnectCapability } from './mcp-server-reconnect.ts'
import { mcpServerRefreshCapability } from './mcp-server-refresh.ts'
import { mcpServerRemoveCapability } from './mcp-server-remove.ts'
import { mcpServerSetEnabledCapability } from './mcp-server-set-enabled.ts'

export const mcpServersDomain = defineDomain({
	name: capabilityDomainNames.mcpServers,
	description:
		'User-added MCP servers callable as kody.mcp["server-name"].tool_name(...).',
	keywords: [
		'mcp',
		'server',
		'client',
		'connect',
		'oauth',
		'remote',
		'tools',
		'integration',
		'model context protocol',
	],
	capabilities: [
		mcpServerAddCapability,
		mcpServerListCapability,
		mcpServerReconnectCapability,
		mcpServerRefreshCapability,
		mcpServerRemoveCapability,
		mcpServerSetEnabledCapability,
	],
})
