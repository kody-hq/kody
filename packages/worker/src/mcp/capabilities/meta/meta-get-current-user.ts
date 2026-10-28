import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emptyCapabilityInputSchema,
	type CapabilityContext,
} from '#mcp/capabilities/types.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { getMcpUserPackageScope } from '#worker/package-registry/user-scope.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { requireMcpRequest, requireMcpUser } from './require-user.ts'

const outputSchema = z.object({
	user_id: z.string(),
	username: z.string(),
	email: z.union([
		z.email(),
		z
			.literal('')
			.describe('Empty when the caller is a team org, not a person.'),
	]),
	display_name: z.string(),
	org: z.object({
		slug: z.string().describe('Package scope and package-app subdomain.'),
	}),
})

/**
 * Member inbound email and inherited runs execute as the org identity on a
 * person's behalf. Report that person only while they hold a role in the
 * request's org, so their account email never surfaces in an org they do not
 * belong to. A suspended or removed account falls back to the runtime identity
 * instead of failing the read.
 */
async function loadActingMember(
	db: D1Database,
	request: RequestContext,
	runtimeUser: McpUserContext,
): Promise<McpUserContext | null> {
	const actor = request.actor
	if (!actor || actor.userId === runtimeUser.userId || !request.membership) {
		return null
	}
	const row = await db
		.prepare(
			`SELECT email, username, display_name
			 FROM users
			 WHERE stable_user_id = ?
			   AND suspended_at IS NULL
			   AND deleting_at IS NULL${andLiveDeletedAtSql()}
			 LIMIT 1`,
		)
		.bind(actor.userId)
		.first<{ email: string; username: string; display_name: string | null }>()
	if (!row) return null
	return {
		...runtimeUser,
		userId: actor.userId,
		email: row.email,
		displayName: row.display_name?.trim() || resolveDisplayName(row),
	}
}

export const metaGetCurrentUserCapability = defineDomainCapability(
	capabilityDomainNames.meta,
	{
		name: 'metaGetCurrentUser',
		contextRuns: 'allow',
		orgPermission: 'none',
		description:
			'Get harmless identity fields for the signed-in MCP user: id, username, email, display name, and the slug of the org this request acts in. Email is empty when the caller is a team org rather than a person. Use email and display_name as git user.email / user.name on Kody remotes when a git-remote result is not already in hand.',
		keywords: [
			'user',
			'current user',
			'profile',
			'identity',
			'account',
			'email',
			'name',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: emptyCapabilityInputSchema,
		outputSchema,
		async handler(_args, ctx: CapabilityContext) {
			const runtimeUser = requireMcpUser(ctx.callerContext)
			const request = requireMcpRequest(ctx.callerContext)
			const user =
				(await loadActingMember(ctx.env.APP_DB, request, runtimeUser)) ??
				runtimeUser
			const username =
				request.actor?.username ??
				(await getMcpUserPackageScope(ctx.env.APP_DB, user))
			return {
				user_id: user.userId,
				username,
				email: user.email,
				display_name: user.displayName,
				org: { slug: request.org.slug ?? username },
			}
		},
	},
)
