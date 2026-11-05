import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import type { HostIntegrationAuthority } from '#mcp/execute-modules/kody-runtime-utils.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import type { PackageStamp } from '#worker/credentials/package-stamp.ts'
import { readIntegrationRuntimeConfig } from './integration-runtime-config.ts'
import { refreshIntegrationTokenForPackage } from './integration-token-refresh.ts'

/**
 * Host-side `createAuthenticatedFetch` authority: config read and token
 * refresh, both acting as `packageStamp`. Callers pass the same stamp the
 * token gateway uses (attested in hosted runs, the verified local binding as
 * claimed in `execute --local`), so a retry cannot drop it (#4889).
 */
export function createHostIntegrationAuthority(input: {
	env: Env
	callerContext: McpCallerContext
	waitUntil?: (promise: Promise<unknown>) => void
	packageStamp: PackageStamp | null
}): HostIntegrationAuthority {
	const { env, callerContext, packageStamp } = input
	return {
		async readConfig(providerName) {
			const { capabilityMap } = await getCapabilityRegistryForContext({
				env,
				callerContext,
			})
			const integrationGet = capabilityMap.integrationGet
			if (!integrationGet) {
				throw new Error(
					'createAuthenticatedFetch is not available in this sandbox.',
				)
			}
			const { integration } = await readIntegrationRuntimeConfig({
				env,
				callerContext,
				integrationGet,
				packageStamp,
				args: { name: providerName },
			})
			return integration
		},
		refresh: (providerName) =>
			refreshIntegrationTokenForPackage({
				env,
				callerContext,
				...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
				packageStamp,
				name: providerName,
			}),
	}
}
