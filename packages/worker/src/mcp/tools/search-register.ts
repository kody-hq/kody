import type { McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'

import {
	searchTool,
	searchToolInputSchema,
	searchToolOutputSchema,
	type SearchToolArgs,
} from './search-tool-definition.ts'
import { runSearchTool } from './search-tool-runner.ts'
import { buildKodyToolIcons } from './tool-icons.ts'

export async function registerSearchTool(agent: McpRegistrationAgent) {
	const icons = buildKodyToolIcons(agent.getCallerContext().baseUrl)
	agent.server.registerTool(
		searchTool.name,
		{
			title: searchTool.title,
			description: searchTool.description,
			inputSchema: searchToolInputSchema,
			outputSchema: searchToolOutputSchema,
			annotations: searchTool.annotations,
			...(icons ? { icons } : {}),
		},
		async (args: SearchToolArgs) =>
			runSearchTool({
				env: agent.getEnv(),
				callerContext: agent.getCallerContext(),
				args,
				mcpAgent: agent,
			}),
	)
}
