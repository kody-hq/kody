import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type PermissionString,
	userHasPermission,
} from '#universal/permissions.ts'
import { requireMcpUser } from './require-user.ts'

export function requireMcpUserWithPermission(
	context: McpCallerContext,
	permission: PermissionString,
) {
	const user = requireMcpUser(context)
	if (
		!userHasPermission(
			{ permissions: (user.permissions ?? []) as Array<PermissionString> },
			permission,
		)
	) {
		throw new Error(`MCP user lacks required permission: ${permission}`)
	}
	return user
}
