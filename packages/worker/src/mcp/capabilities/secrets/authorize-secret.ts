import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	authorize,
	authorizeOrgWide,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import {
	credentialResource,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { findSecret } from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { type StorageContext } from '#mcp/storage.ts'

type SecretPermission = Extract<OrgPermission, `secret:${string}`>

/**
 * What the secret checks read from a capability context. The website passes
 * its signed-in session here so its approvals run the same checks.
 */
export type SecretAuthorizationContext = {
	env: CapabilityContext['env']
	callerContext: Pick<CapabilityContext['callerContext'], 'request' | 'user'>
}

/**
 * Secrets are checked as the `credential` resource of the entry `name`
 * resolves to (the key `resolveCredential` checks). A missing secret is
 * checked against a target no grant names, so only org-wide holders pass.
 */
export async function authorizeSecret(
	ctx: SecretAuthorizationContext,
	permission: SecretPermission,
	input: {
		name: string
		scope?: SecretScope | null
		storageContext?: StorageContext | null
	},
) {
	const request = requireMcpRequest(ctx.callerContext)
	const name = input.name.trim()
	const found = await findSecret({
		env: ctx.env,
		userId: ownerIdFromCaller(ctx.callerContext),
		name,
		scope: input.scope ?? undefined,
		storageContext: input.storageContext ?? null,
		includeExpired: true,
	})
	await authorize(
		{ env: ctx.env, request },
		permission,
		found.credentialId
			? credentialResource(request.org.id, { id: found.credentialId, name })
			: missingCredentialResource(request.org.id, name),
	)
}

/** Updating a secret needs Write on it; creating one needs org-level Create. */
export async function authorizeSecretSet(
	ctx: SecretAuthorizationContext,
	input: {
		name: string
		scope: SecretScope
		storageContext: StorageContext | null
	},
) {
	const name = input.name.trim()
	const existing = await findSecret({
		env: ctx.env,
		userId: ownerIdFromCaller(ctx.callerContext),
		name,
		scope: input.scope,
		storageContext: input.storageContext,
		includeExpired: true,
	})
	if (existing.credentialId) {
		await authorize(
			{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
			'secret:write',
			credentialResource(requireMcpRequest(ctx.callerContext).org.id, {
				id: existing.credentialId,
				name,
			}),
		)
		return
	}
	await authorize(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		'secret:create',
	)
}

export async function loadSecretListScope(
	ctx: CapabilityContext,
	permission: SecretPermission,
) {
	return await loadResourceListScope(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
		'credential',
	)
}

/** Vault provider bindings are org-wide configuration, not one secret. */
export async function authorizeSecretOrgWide(
	ctx: CapabilityContext,
	permission: SecretPermission,
) {
	await authorizeOrgWide(
		{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
		permission,
	)
}
