import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	AuthorizationError,
	authorize,
	authorizeOrgWide,
} from '#worker/authorization/authorize.ts'
import {
	credentialResource,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { findIntegrationCredentialId } from '#worker/integrations/credentials.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import {
	findOauthAppReusedByConfig,
	type OauthAppConfigInput,
} from '#worker/integrations/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { PermissionDeniedError } from '#universal/permission-denied.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'

type WebsiteUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type IntegrationPermission = Extract<OrgPermission, `integration:${string}`>

/**
 * Website twin of the MCP integration capability checks: OAuth app and
 * connection config changes need the same `integration:*` permission. A
 * denial becomes a `PermissionDeniedError` whose message the connect page and
 * 403 route render as-is. Personal-org callers are Owners, so they pass.
 */
export async function requireWebsiteIntegrationPermission(input: {
	env: Env
	user: WebsiteUser
	permission: IntegrationPermission
	/** Verb phrase for the denial, e.g. "save OAuth apps". */
	action: string
	/** Check one connection (grants count); omit for org-wide app config. */
	connectionName?: string
}) {
	const request = input.user.request
	try {
		try {
			await authorizeOrgWide({ env: input.env, request }, input.permission)
			return
		} catch (error) {
			if (input.connectionName == null) throw error
			if (!(error instanceof AuthorizationError)) throw error
		}
		const orgId = ownerIdFromCaller({ request, user: input.user.mcpUser })
		const credentialId = await findIntegrationCredentialId({
			env: input.env,
			userId: orgId,
			name: input.connectionName,
		})
		await authorize(
			{ env: input.env, request },
			input.permission,
			credentialId
				? credentialResource(orgId, {
						id: credentialId,
						name: input.connectionName,
					})
				: missingCredentialResource(orgId, input.connectionName),
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		const org = request?.org.slug
			? `the ${request.org.slug} organization`
			: 'this organization'
		throw new PermissionDeniedError(
			`You can't ${input.action} in ${org}. That needs ${input.permission}; ask an org Owner to grant it, or pick an organization where you have it.`,
			{ permission: input.permission, cause: error },
		)
	}
}

/**
 * Connecting through an org's existing OAuth app stays open to members when it
 * adds a new connection. Replacing an existing connection's tokens, or creating
 * or rewriting the app row or its client secret, needs `integration:write`.
 */
export async function requireWebsiteOauthAppConnectAccess(input: {
	env: Env
	user: WebsiteUser
	config: OauthAppConfigInput
	clientSecret?: string | null
}) {
	if (!input.clientSecret?.trim()) {
		const reused = await findOauthAppReusedByConfig({
			env: input.env,
			userId: ownerIdFromCaller({
				request: input.user.request,
				user: input.user.mcpUser,
			}),
			config: input.config,
		})
		if (reused) {
			const connectionName = canonicalIntegrationName(input.config.name)
			const existing = await findIntegrationCredentialId({
				env: input.env,
				userId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				name: connectionName,
			})
			if (!existing) return
			await requireWebsiteIntegrationPermission({
				env: input.env,
				user: input.user,
				permission: 'integration:write',
				action: 'replace this connection',
				connectionName,
			})
			return
		}
	}
	await requireWebsiteIntegrationPermission({
		env: input.env,
		user: input.user,
		permission: 'integration:write',
		action: 'add or change OAuth apps',
	})
}
