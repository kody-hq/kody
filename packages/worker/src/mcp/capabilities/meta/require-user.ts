import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

// Missing auth is caller-clearable (e.g. an anonymous package-app visitor
// calling meta_get_current_user), so it stays on mcp-event and out of
// Sentry. KODY-9C.

/** The signed-in person. Callers may pass a full caller context or just `user`. */
export function requireMcpUser(context: { user?: McpCallerContext['user'] }) {
	if (!context.user) {
		throw new McpCallerError(
			'Authenticated MCP user is required for this capability.',
		)
	}
	return context.user
}

/** The org-bound request. Callers may pass a full caller context or just `request`. */
export function requireMcpRequest(context: {
	request?: McpCallerContext['request']
}) {
	if (!context.request) {
		throw new McpCallerError(
			'Authenticated MCP user is required for this capability.',
		)
	}
	return context.request
}
