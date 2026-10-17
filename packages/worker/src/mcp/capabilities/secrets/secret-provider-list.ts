import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { credentialFillPlacementSchema } from '#worker/credentials/fill-placement.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { listBoundSecretProviders } from '#mcp/secrets/secret-providers/service.ts'
import { authorizeSecretOrgWide } from './authorize-secret.ts'

export const secretProviderListCapability = defineDomainCapability(
	capabilityDomainNames.secrets,
	{
		name: 'secretProviderList',
		orgPermission: 'secret:use',
		description:
			'List account-bound external secret providers (credential id for accessGrant, provider id, bound package, door-key secret name, fill placement, non-secret config). Never returns credential values or vault items. Search does not crawl vaults.',
		keywords: ['secret', 'provider', '1password', 'binding', 'list'],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({}),
		outputSchema: z.object({
			bindings: z.array(
				z.object({
					credential_id: z.string(),
					provider: z.string(),
					package_id: z.string(),
					door_secret_name: z.string(),
					placement: credentialFillPlacementSchema
						.nullable()
						.describe(
							'Where vault placeholders may be filled. Null means anywhere.',
						),
					config: z.record(z.string(), z.string()),
				}),
			),
		}),
		async handler(_args, ctx: CapabilityContext) {
			requireMcpUser(ctx.callerContext)
			await authorizeSecretOrgWide(ctx, 'secret:use')
			const bindings = await listBoundSecretProviders({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
			})
			return {
				bindings: bindings.map((binding) => ({
					credential_id: binding.credentialId,
					provider: binding.providerId,
					package_id: binding.packageId,
					door_secret_name: binding.doorSecretName,
					placement: binding.placement,
					config: binding.config,
				})),
			}
		},
	},
)
