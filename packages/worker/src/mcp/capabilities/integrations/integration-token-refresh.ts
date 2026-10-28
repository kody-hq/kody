import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertCredentialUsesDeclared } from '#worker/credentials/credential-need-enforcement.ts'
import { attestedPackageStampFromCaller } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { IntegrationTokenRefreshCallerError } from '#worker/integrations/token-refresh.ts'

const inputSchema = z.object({
	name: z
		.string()
		.min(1)
		.describe('Integration (connection) name whose tokens should refresh.'),
})

const outputSchema = z.object({
	ok: z.literal(true),
	refreshed: z.boolean(),
	skippedReason: z.enum(['refresh_not_applicable']).nullable(),
	refreshedAt: z.string().nullable(),
	refreshTokenRotated: z.boolean(),
})

export const integrationTokenRefreshCapability = defineDomainCapability(
	capabilityDomainNames.integrations,
	{
		name: 'integrationTokenRefresh',
		contextRuns: 'deny',
		orgPermission: 'integration:use',
		description:
			'Refresh the OAuth access token for a saved integration host-side and persist the new tokens on the connection. Connections whose provider issued neither a refresh token nor an access-token expiry at connect (for example GitHub OAuth Apps with token expiration off) are skipped with refreshed: false instead of failing. Returns metadata only — token values never appear in the output. createAuthenticatedFetch refreshes through this path for every integration; it is the only refresh path for platform (built-in) integrations, whose shared client secret stays server-side.',
		keywords: [
			'integration',
			'oauth',
			'token',
			'refresh',
			'access token',
			'expired',
			'platform',
			'built-in',
		],
		readOnly: false,
		// Not idempotent: providers may rotate the refresh token on each call,
		// so an automatic retry could present an already-consumed token.
		idempotent: false,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx: CapabilityContext) {
			const user = requireMcpUser(ctx.callerContext)
			const { packageStamp } = attestedPackageStampFromCaller({
				storageContext: ctx.callerContext.storageContext,
			})
			const orgId = ownerIdFromCaller(ctx.callerContext)
			// Webhook 401 retry shares integration-refresh and picks names
			// that are not stamp keys. Only this capability is package code.
			if (packageStamp?.packageId && orgId) {
				await assertCredentialUsesDeclared({
					env: ctx.env,
					request: ctx.callerContext.request,
					orgId,
					packageId: packageStamp.packageId,
					references: [{ use: 'integration', name: args.name }],
				})
			}
			try {
				const result = await resolveCredential({
					env: ctx.env,
					orgId,
					actor: ctx.callerContext.request,
					packageStamp,
					baseUrl: ctx.callerContext.baseUrl,
					credential: {
						use: 'integration-refresh',
						name: args.name,
						userEmail: user.email,
						waitUntil: ctx.waitUntil,
					},
				})
				return {
					ok: true as const,
					refreshed: result.refreshed,
					skippedReason: result.refreshed ? null : result.skippedReason,
					refreshedAt: result.refreshedAt,
					refreshTokenRotated: result.refreshTokenRotated,
				}
			} catch (error) {
				// Missing refresh token, revoked grant (HTTP 4xx), host-approval
				// gaps — caller-clearable reconnect state, not platform defects.
				if (error instanceof IntegrationTokenRefreshCallerError) {
					throw new McpCallerError(error.message, { cause: error })
				}
				throw error
			}
		},
	},
)
