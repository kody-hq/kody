import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { bindSecretProvider } from '#mcp/secrets/secret-providers/service.ts'
import { authorizeSecretOrgWide } from './authorize-secret.ts'

export const secretProviderBindCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretProviderBind',
		contextRuns: 'deny',
		orgPermission: 'secret:write',
		description:
			'Pin which saved package serves an external secret provider id for this account, plus which user secret holds the door key. Declaring kody.secretProvider on a package does not bind it. Owner-controlled; does not return secret values.',
		keywords: ['secret', 'provider', '1password', 'bind', 'service account'],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			provider: z
				.string()
				.min(1)
				.describe('Provider id to bind, for example 1password.'),
			package_id: z
				.string()
				.min(1)
				.describe(
					'Saved package id that declares kody.secretProvider.id for this provider.',
				),
			door_secret_name: z
				.string()
				.min(1)
				.describe(
					'User-scoped Kody secret that holds the provider door key (service account token).',
				),
			config: z
				.record(z.string(), z.string())
				.optional()
				.describe(
					'Optional non-secret provider config such as a Connect base URL.',
				),
		}),
		outputSchema: z.object({
			provider: z.string(),
			package_id: z.string(),
			kody_id: z.string(),
			door_secret_name: z.string(),
			config: z.record(z.string(), z.string()),
		}),
		async handler(args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeSecretOrgWide(ctx, 'secret:write')
			try {
				const bound = await bindSecretProvider({
					env: ctx.env,
					baseUrl: ctx.callerContext.baseUrl,
					userId: ownerIdFromCaller(ctx.callerContext),
					providerId: args.provider,
					packageId: args.package_id,
					doorSecretName: args.door_secret_name,
					config: args.config,
					audit: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
				})
				return {
					provider: bound.providerId,
					package_id: bound.packageId,
					kody_id: bound.kodyId,
					door_secret_name: bound.doorSecretName,
					config: bound.config,
				}
			} catch (error) {
				if (error instanceof McpCallerError) throw error
				throw new McpCallerError(
					error instanceof Error
						? error.message
						: 'Unable to bind this secret provider.',
					{ cause: error },
				)
			}
		},
	},
)
