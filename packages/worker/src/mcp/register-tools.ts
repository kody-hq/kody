import type { McpRegistrationAgent } from './mcp-registration-agent.ts'
import { registerPrompts } from './register-prompts.ts'
import { registerApiTool } from './tools/api.ts'
import { registerExecuteTool } from './tools/execute.ts'
import { registerSearchTool } from './tools/search.ts'

export async function registerTools(agent: McpRegistrationAgent) {
	await registerSearchTool(agent)
	await registerExecuteTool(agent)
	await registerApiTool(agent)
	await registerPrompts(agent)
}
