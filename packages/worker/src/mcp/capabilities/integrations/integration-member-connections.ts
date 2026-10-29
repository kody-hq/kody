/**
 * Org admins list and revoke members' personal connections made through the
 * org's OAuth apps (ADR 0068 amendment 2026-10-29). The member owns each
 * connection; admins see metadata only and can revoke it, never use it or
 * read its tokens. `integration:manage_access` is the gate because revoking
 * decides who may use the org's integrations, the same call as managing
 * access grants on them.
 */
import { z } from 'zod'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	listPinnedConnectionsForOrg,
	wipePinnedConnection,
} from '#worker/integrations/pinned-connections.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

const memberConnectionSchema = z.object({
	credential_id: z.string(),
	member: z.object({
		username: z.string().nullable(),
		display_name: z.string().nullable(),
	}),
	app_slug: z.string(),
	app_label: z.string().nullable(),
	provider: z.string().nullable(),
	account_label: z.string().nullable(),
	connected_at: z.string().nullable(),
	created_at: z.string(),
})

export const integrationMemberConnectionListCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationMemberConnectionList',
		contextRuns: 'deny',
		orgPermission: 'integration:manage_access',
		description:
			"List members' own OAuth connections made through this org's OAuth apps (ADR 0068). Each one belongs to the member and works only in this org, only in that member's runs. Shows the member, app, account label, and connected date; never tokens or scopes.",
		keywords: [
			'integration',
			'oauth',
			'member',
			'personal',
			'connection',
			'list',
			'admin',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			app_slug: z
				.string()
				.min(1)
				.optional()
				.describe('Only connections made through this org OAuth app.'),
		}),
		outputSchema: z.object({ connections: z.array(memberConnectionSchema) }),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			// Org-wide only: a grant on one integration does not reach every
			// member's connection.
			await authorizeOrgWide(
				{ env: ctx.env, request: ctx.callerContext.request ?? null },
				'integration:manage_access',
			)
			const connections = await listPinnedConnectionsForOrg({
				db: ctx.env.APP_DB,
				pinnedOrgId: ownerIdFromCaller(ctx.callerContext),
				...(args.app_slug ? { appSlug: args.app_slug } : {}),
			})
			return {
				connections: connections.map((connection) => ({
					credential_id: connection.credentialId,
					member: {
						username: connection.ownerUsername,
						display_name: connection.ownerDisplayName,
					},
					app_slug: connection.appSlug,
					app_label: connection.appLabel,
					provider: connection.provider,
					account_label: connection.accountLabel,
					connected_at: connection.connectedAt,
					created_at: connection.createdAt,
				})),
			}
		},
	},
)

export const integrationMemberConnectionRevokeCapability =
	defineDomainCapability(capabilityDomainNames.integrations, {
		name: 'integrationMemberConnectionRevoke',
		contextRuns: 'deny',
		orgPermission: 'integration:manage_access',
		description:
			"Revoke a member's own OAuth connection made through this org's OAuth app (ADR 0068). Wipes it from the member's personal org, removes its grant to this org, and revokes the token with the provider when the provider supports it. `upstream` says what the provider did; a provider failure never blocks the local wipe.",
		keywords: [
			'integration',
			'oauth',
			'member',
			'personal',
			'connection',
			'revoke',
			'admin',
		],
		readOnly: false,
		idempotent: false,
		destructive: true,
		inputSchema: z.object({
			credential_id: z
				.string()
				.min(1)
				.describe('credential_id from integrationMemberConnectionList.'),
		}),
		outputSchema: z.object({
			revoked: z.boolean(),
			upstream: z.enum([
				'revoked',
				'already_invalid',
				'unsupported',
				'no_token',
				'failed',
			]),
		}),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			// Org-wide only: a grant on one integration does not reach every
			// member's connection.
			await authorizeOrgWide(
				{ env: ctx.env, request: ctx.callerContext.request ?? null },
				'integration:manage_access',
			)
			const [connection] = await listPinnedConnectionsForOrg({
				db: ctx.env.APP_DB,
				pinnedOrgId: ownerIdFromCaller(ctx.callerContext),
				credentialId: args.credential_id,
			})
			if (!connection) {
				throw new McpCallerError(
					"No member connection with that credential_id uses this org's OAuth apps.",
				)
			}
			const result = await wipePinnedConnection({
				env: ctx.env,
				connection,
				reason: 'admin_revoked',
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
			return { revoked: result.wiped, upstream: result.upstream.outcome }
		},
	})
