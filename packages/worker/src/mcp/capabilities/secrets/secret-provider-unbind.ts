import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { unbindSecretProvider } from '#mcp/secrets/secret-providers/service.ts'
import { authorizeSecretOrgWide } from './authorize-secret.ts'

export const secretProviderUnbindCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretProviderUnbind',
		contextRuns: 'deny',
		orgPermission: 'secret:delete',
		description:
			'Remove the account binding for an external secret provider id. Unbind and rebind to a different package drop every grant for that provider. Does not return secret values.',
		keywords: ['secret', 'provider', 'unbind', 'disconnect'],
		readOnly: false,
		idempotent: true,
		destructive: true,
		inputSchema: z.object({
			provider: z.string().min(1).describe('Provider id to unbind.'),
		}),
		outputSchema: z.object({
			provider: z.string(),
			unbound: z.boolean(),
		}),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeSecretOrgWide(ctx, 'secret:delete')
			const result = await unbindSecretProvider({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				providerId: args.provider,
				audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
			})
			return { provider: result.providerId, unbound: true }
		},
	},
)
