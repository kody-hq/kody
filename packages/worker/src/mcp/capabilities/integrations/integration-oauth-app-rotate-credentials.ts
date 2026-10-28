import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeIntegrationOrgWide } from '#mcp/capabilities/integrations/authorize-integration.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import {
	getOauthApp,
	listJoinedIntegrations,
	rotateOauthAppClientCredentials,
} from '#worker/integrations/service.ts'
import { oauthAppPublicSchema, toOauthAppPublic } from './oauth-app-shared.ts'

const inputSchema = z
	.object({
		slug: z
			.string()
			.min(1)
			.describe('OAuth app slug whose client credentials should be rotated.'),
		clientId: z.string().min(1).describe('New OAuth client id (inline value).'),
	})
	.strict()

const outputSchema = z.object({
	app: oauthAppPublicSchema,
})

export const integrationOauthAppRotateCredentialsCapability =
	defineDomainCapability(capabilityDomainNames.integrations, {
		name: 'integrationOauthAppRotateCredentials',
		contextRuns: 'deny',
		orgPermission: 'integration:write',
		description:
			'Rotate the client id on a shared OAuth app. Every connection on that app sees the new client id on the next join — one write instead of updating each connection. Rotate the client secret value from /account/integrations.',
		keywords: [
			'integration',
			'oauth',
			'app',
			'client',
			'credentials',
			'rotate',
			'update',
			'secret',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeIntegrationOrgWide(ctx, 'integration:write')
			const existing = await getOauthApp({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				slug: args.slug,
			})
			if (!existing) {
				throw new Error(
					`OAuth app "${args.slug.trim()}" was not found for this user.`,
				)
			}
			const rotated = await rotateOauthAppClientCredentials({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				slug: args.slug,
				clientId: args.clientId,
			})
			const joined = await listJoinedIntegrations({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
			})
			const connections = joined
				.filter(
					(entry) => entry.lane === 'user' && entry.app.slug === rotated.slug,
				)
				.map(({ connection }) => ({
					name: connection.name,
					accountLabel: connection.accountLabel,
				}))
			return {
				app: toOauthAppPublic(
					{ ...rotated, connectionCount: connections.length },
					connections,
				),
			}
		},
	})
