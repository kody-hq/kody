/**
 * Host-side config read behind `createAuthenticatedFetch(name)`. Not a
 * capability (no search, Open API, or MCP tool). It answers exactly like the
 * public `integrationGet` run-org read, except that when the run org has no
 * connection of that name it may return the actor's own personal connection
 * granted to the run org: the same set, with the same checks, the
 * integration-token gateway resolves. Non-secret config only; tokens stay
 * host-side.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import {
	authorizePersonalIntegrationLookup,
	findIntegrationLookupByName,
} from '#worker/credentials/oauth-resolvers.ts'
import { attestedPackageStampFromCaller } from '#worker/credentials/package-stamp.ts'
import { assertCanUseIntegration } from '#worker/integrations/package-access.ts'
import { getIntegration } from '#worker/integrations/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { assertCallerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import { canonicalIntegrationName } from './integration-shared.ts'

export type IntegrationRuntimeConfig = {
	name: string
	apiBaseUrl: string | null
	requiredHosts: Array<string>
}

function toRuntimeConfig(
	integration: {
		name: string
		apiBaseUrl?: string | null
		requiredHosts?: Array<string>
	} | null,
): IntegrationRuntimeConfig | null {
	if (!integration) return null
	return {
		name: integration.name,
		apiBaseUrl: integration.apiBaseUrl ?? null,
		requiredHosts: [...(integration.requiredHosts ?? [])],
	}
}

async function readGrantedPersonalConfig(input: {
	env: Env
	callerContext: McpCallerContext
	integrationGet: Capability
	name: string
}): Promise<IntegrationRuntimeConfig | null> {
	const { env, callerContext, name } = input
	const request = callerContext.request ?? null
	const orgId = ownerIdFromCaller(callerContext)
	const lookup = await findIntegrationLookupByName({
		env,
		orgId,
		actor: request,
		name,
	})
	if (lookup.owner !== 'personal' || !lookup.credentialId) return null
	requireMcpUser(callerContext)
	await assertCallerCanAccessCapability(callerContext, input.integrationGet, {
		env,
	})
	try {
		// The gateway resolver's personal checks: integration:use token scope,
		// live grant to the run org, actor is the owner, live org binding.
		await authorizePersonalIntegrationLookup({
			env,
			orgId,
			actor: request,
			credentialId: lookup.credentialId,
			name,
		})
	} catch (error) {
		// Answer exactly as the run-org read does, without hinting the personal
		// connection exists.
		if (error instanceof AuthorizationError) return null
		throw error
	}
	const { packageStamp } = attestedPackageStampFromCaller({
		storageContext: callerContext.storageContext,
	})
	await assertCanUseIntegration({
		env,
		baseUrl: callerContext.baseUrl,
		userId: lookup.ownerId,
		name,
		packageId: packageStamp?.packageId ?? null,
	})
	return toRuntimeConfig(
		await getIntegration({ env, userId: lookup.ownerId, name }),
	)
}

export async function readIntegrationRuntimeConfig(input: {
	env: Env
	callerContext: McpCallerContext
	/** The public run-org read; every other answer comes from it unchanged. */
	integrationGet: Capability
	args: unknown
}): Promise<{ integration: IntegrationRuntimeConfig | null }> {
	const { env, callerContext, integrationGet, args } = input
	const rawName = (args as { name?: unknown } | null)?.name
	if (typeof rawName === 'string' && rawName.trim()) {
		const personal = await readGrantedPersonalConfig({
			env,
			callerContext,
			integrationGet,
			name: canonicalIntegrationName(rawName),
		})
		if (personal) return { integration: personal }
	}
	const result = (await integrationGet.handler(
		(args ?? {}) as Record<string, unknown>,
		{ env, callerContext },
	)) as { integration?: Parameters<typeof toRuntimeConfig>[0] }
	return { integration: toRuntimeConfig(result.integration ?? null) }
}
