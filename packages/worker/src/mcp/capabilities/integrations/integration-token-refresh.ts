import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { authorizeSurface } from '#worker/authorization/authorize.ts'
import { assertGuestCapabilityAllowed } from '#worker/guest/guest-policy.ts'
import type { CapabilityContext } from '#mcp/capabilities/types.ts'
import { assertCredentialUsesDeclared } from '#worker/credentials/credential-need-enforcement.ts'
import {
	attestedPackageStampFromCaller,
	type PackageStamp,
} from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { assertContextRunAllowed } from '#worker/execution-contexts/context-run-policy.ts'
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
			const { packageStamp } = attestedPackageStampFromCaller({
				storageContext: ctx.callerContext.storageContext,
			})
			return await refreshIntegrationTokenForPackage({
				env: ctx.env,
				callerContext: ctx.callerContext,
				waitUntil: ctx.waitUntil,
				packageStamp,
				name: args.name,
			})
		},
	},
)

/**
 * Hosted runs pass the attested stamp from the caller. CapabilityProxy
 * (`execute --local`) passes the verified package binding as a claimed stamp,
 * so the integration's package lock still sees the calling package.
 */
export async function refreshIntegrationTokenForPackage(input: {
	env: Env
	callerContext: CapabilityContext['callerContext']
	waitUntil?: (promise: Promise<unknown>) => void
	packageStamp: PackageStamp | null
	name: string
}): Promise<z.infer<typeof outputSchema>> {
	const { env, callerContext, packageStamp, name } = input
	// Direct callers skip the capability wrapper, so apply its gates here too.
	assertContextRunAllowed(
		callerContext.request,
		integrationTokenRefreshCapability.name,
		integrationTokenRefreshCapability.contextRuns,
	)
	await assertCallerCanAccessCapability(
		callerContext,
		integrationTokenRefreshCapability,
		{ env },
	)
	await assertGuestCapabilityAllowed({
		env,
		callerContext,
		capabilityName: integrationTokenRefreshCapability.name,
		readOnly: false,
		args: { name },
	})
	await authorizeSurface(
		{ env, request: callerContext.request },
		integrationTokenRefreshCapability.orgPermission,
	)
	const user = requireMcpUser(callerContext)
	const orgId = ownerIdFromCaller(callerContext)
	// Webhook 401 retry shares integration-refresh and picks names
	// that are not stamp keys. Only this capability is package code.
	if (packageStamp?.packageId && orgId) {
		await assertCredentialUsesDeclared({
			env,
			request: callerContext.request,
			orgId,
			packageId: packageStamp.packageId,
			references: [{ use: 'integration', name }],
		})
	}
	try {
		const result = await resolveCredential({
			env,
			orgId,
			actor: callerContext.request,
			packageStamp,
			baseUrl: callerContext.baseUrl,
			credential: {
				use: 'integration-refresh',
				name,
				userEmail: user.email,
				waitUntil: input.waitUntil,
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
}
