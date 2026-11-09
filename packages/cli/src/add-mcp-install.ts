import {
	upsertServer,
	type AgentType,
	type InstallResult,
	type McpServerConfig,
} from 'add-mcp'
import type { HostId } from './host-catalog.js'

/**
 * Hosts whose on-disk MCP config `add-mcp` already knows how to merge.
 * Claude Desktop is intentionally omitted: remote MCP lives in Connectors, not
 * `claude_desktop_config.json`.
 */
export const addMcpAgentByHostId = {
	antigravity: 'antigravity',
	cline: 'cline',
	'cline-cli': 'cline-cli',
	'claude-code': 'claude-code',
	codex: 'codex',
	cursor: 'cursor',
	fx: 'fx',
	'gemini-cli': 'gemini-cli',
	goose: 'goose',
	'copilot-cli': 'github-copilot-cli',
	'grok-build': 'grok-build',
	'kilo-code': 'kilo-code',
	'kimi-code': 'kimi-code',
	'kiro-cli': 'kiro-cli',
	mastracode: 'mastracode',
	mcporter: 'mcporter',
	opencode: 'opencode',
	pi: 'pi',
	vscode: 'vscode',
	windsurf: 'windsurf',
	zed: 'zed',
} as const satisfies Partial<Record<HostId, AgentType>>

export type AddMcpHostId = keyof typeof addMcpAgentByHostId

const addMcpProjectHosts = new Set<AddMcpHostId>([
	'claude-code',
	'codex',
	'cursor',
	'gemini-cli',
	'copilot-cli',
	'grok-build',
	'kilo-code',
	'kimi-code',
	'kiro-cli',
	'mastracode',
	'mcporter',
	'opencode',
	'pi',
	'vscode',
	'zed',
])

export type UpsertServerFn = (
	agentType: AgentType,
	serverName: string,
	serverConfig: McpServerConfig,
	options?: { local?: boolean; cwd?: string },
) => InstallResult

export function isAddMcpHostId(id: HostId): id is AddMcpHostId {
	return Object.hasOwn(addMcpAgentByHostId, id)
}

export function addMcpUsesProjectScope(
	id: AddMcpHostId,
	project: boolean,
): boolean {
	return project && addMcpProjectHosts.has(id)
}

export function kodyRemoteConfig(mcpUrl: string): McpServerConfig {
	return { type: 'http', url: mcpUrl }
}

export function defaultUpsertServer(
	agentType: AgentType,
	serverName: string,
	serverConfig: McpServerConfig,
	options?: { local?: boolean; cwd?: string },
): InstallResult {
	return upsertServer(agentType, serverName, serverConfig, options)
}
