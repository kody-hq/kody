/**
 * Assemble MCP server instructions for a caller: neutral stub + optional
 * user overlay. Both `/mcp` lanes call this helper.
 */

import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildMcpServerInstructions } from '#mcp/server-instructions.ts'
import { getMcpUserServerInstructions } from '#mcp/user-server-instructions-repo.ts'

export async function assembleMcpServerInstructionsForCaller(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<string> {
	const userId = input.callerContext.user?.userId ?? null
	const overlay =
		userId !== null
			? await getMcpUserServerInstructions(input.env.APP_DB, userId)
			: null
	return buildMcpServerInstructions(overlay)
}
