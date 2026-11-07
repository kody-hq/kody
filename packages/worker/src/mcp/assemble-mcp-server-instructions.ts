/**
 * Assemble MCP server instructions for a caller: neutral stub + optional
 * user overlay. Both `/mcp` lanes call this helper.
 */

import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildMcpServerInstructions } from '#mcp/server-instructions.ts'
import { getMcpUserServerInstructions } from '#mcp/user-server-instructions-repo.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { workspaceScopeAgentNote } from '#universal/workspace-scope.ts'

export async function assembleMcpServerInstructionsForCaller(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<string> {
	const userId = input.callerContext.user?.userId ?? null
	const overlay =
		userId !== null
			? await getMcpUserServerInstructions(input.env.APP_DB, userId)
			: null
	const base = buildMcpServerInstructions(overlay)
	const request = input.callerContext.request
	const slug = request?.org.slug?.trim()
	if (!slug || !request) return base
	let personal: boolean
	try {
		personal = await isPersonalOrg(input.env.APP_DB, request.org.id)
	} catch {
		// Kind unknown: omit the note rather than guessing team.
		return base
	}
	return `${base}

${workspaceScopeAgentNote({
	slug,
	kind: personal ? 'personal' : 'team',
})}`
}
