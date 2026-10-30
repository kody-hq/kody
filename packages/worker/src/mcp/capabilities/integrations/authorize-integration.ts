import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	authorize,
	authorizeOrgWide,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import {
	credentialResource,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { findIntegrationCredentialId } from '#worker/integrations/credentials.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'

type IntegrationPermission = Extract<OrgPermission, `integration:${string}`>

/**
 * An OAuth integration is checked as the `credential` resource of the
 * connection `name` names (the key `resolveCredential` checks). A missing
 * connection is checked against a target no grant names, so only org-wide
 * holders pass.
 */
export async function authorizeIntegration(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
	name: string,
) {
	const request = requireMcpRequest(ctx.callerContext)
	const credentialId = await findIntegrationCredentialId({
		env: ctx.env,
		userId: ownerIdFromCaller(ctx.callerContext),
		name,
	})
	await authorize(
		{ env: ctx.env, request },
		permission,
		credentialId
			? credentialResource(request.org.id, { id: credentialId, name })
			: missingCredentialResource(request.org.id, name),
	)
}

/**
 * Connecting under `name` creates the connection when none exists yet
 * (`integration:create`) and replaces it otherwise (`integration:write`).
 */
export async function authorizeIntegrationConnect(
	ctx: CapabilityContext,
	name: string,
) {
	const credentialId = await findIntegrationCredentialId({
		env: ctx.env,
		userId: ownerIdFromCaller(ctx.callerContext),
		name,
	})
	if (credentialId) {
		await authorizeIntegration(ctx, 'integration:write', name)
		return
	}
	await authorize(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		'integration:create',
	)
}

/** An MCP server's row id is its credential id. */
export async function authorizeMcpServer(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
	server: { id: string; name: string },
) {
	const request = requireMcpRequest(ctx.callerContext)
	await authorize(
		{ env: ctx.env, request },
		permission,
		credentialResource(request.org.id, server),
	)
}

export async function loadIntegrationListScope(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
) {
	return await loadResourceListScope(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
		'credential',
	)
}

/** OAuth app registrations are org-wide configuration, not one connection. */
export async function authorizeIntegrationOrgWide(
	ctx: CapabilityContext,
	permission: IntegrationPermission,
) {
	await authorizeOrgWide(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
	)
}
