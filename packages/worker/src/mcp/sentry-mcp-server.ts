import * as Sentry from '@sentry/cloudflare'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Implementation } from '@modelcontextprotocol/sdk/types.js'
import { buildKodyMcpServerInfo } from './kody-mcp-server-info.ts'

export function createKodyMcpServer(
	options: ConstructorParameters<typeof McpServer>[1],
	serverInfo: Implementation = buildKodyMcpServerInfo(),
): McpServer {
	return Sentry.wrapMcpServerWithSentry(new McpServer(serverInfo, options), {
		recordInputs: false,
		recordOutputs: false,
	})
}
