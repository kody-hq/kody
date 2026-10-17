import {
	type AuthenticatedAppUser,
	type readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { operationResult } from '#app/operation-result.ts'
import {
	orgHasPermission,
	resolveOrgManagementAccess,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizeGrantRevoke } from '#mcp/capabilities/access/shared.ts'
import { type OrgGrantsLoaderData } from '#universal/loader-data.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import {
	getGrantById,
	isGrantResourceType,
	softDeleteGrant,
} from '#worker/orgs/access-writes.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { listOrgGrantsForView } from '#worker/orgs/org-grants-view.ts'

/**
 * Same resource check as grant revoke. Authorization and caller denials mean
 * this viewer cannot revoke the grant; anything else still fails the request.
 */
async function grantRevokeAllowed(
	env: Env,
	user: AuthenticatedAppUser,
	grant: { resourceType: string; resourceId: string },
) {
	if (!isGrantResourceType(grant.resourceType)) return false
	try {
		await authorizeGrantRevoke(
			{
				env,
				callerContext: {
					user: user.mcpUser,
					request: user.request,
				},
			},
			grant.resourceType,
			grant.resourceId,
		)
		return true
	} catch (error) {
		// AuthorizationError is an McpCallerError. Both are denials.
		if (error instanceof McpCallerError) return false
		throw error
	}
}

export async function loadOrgGrantsData(input: {
	env: Env
	user: AuthenticatedAppUser
	org: ManagedOrg
}): Promise<OrgGrantsLoaderData> {
	const canManage = await orgHasPermission(
		input.env,
		input.user,
		'member:write',
	)
	const grants = await listOrgGrantsForView(input.env.APP_DB, input.org.id)
	return {
		ok: true,
		org: input.org,
		canManage,
		grants: await Promise.all(
			grants.map(async (grant) => ({
				...grant,
				canRevoke: await grantRevokeAllowed(input.env, input.user, grant),
			})),
		),
	}
}

export async function revokeOrganizationGrant({
	request,
	env,
	user,
	orgSlug,
	...fields
}: {
	request: Request
	env: Env
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	grantId?: unknown
	orgSlug?: string
}) {
	const access = await resolveOrgManagementAccess({
		request,
		orgSlug,
		env,
		user,
		permission: 'member:write',
	})
	if (!access.ok) {
		return operationResult({ ok: false, error: access.error }, access.status)
	}

	const grantId =
		typeof fields.grantId === 'string' ? fields.grantId.trim() : ''
	if (!grantId) {
		return operationResult({ ok: false, error: 'A grant id is required.' }, 400)
	}
	const grant = await getGrantById({
		db: env.APP_DB,
		orgId: access.org.id,
		grantId,
	})
	if (!grant || !isGrantResourceType(grant.resourceType)) {
		return operationResult(
			{ ok: false, error: 'Grant was not found in this organization.' },
			400,
		)
	}
	try {
		await authorizeGrantRevoke(
			{
				env,
				callerContext: {
					user: user.mcpUser,
					request: user.request,
				},
			},
			grant.resourceType,
			grant.resourceId,
		)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return operationResult({ ok: false, error: error.message }, 403)
		}
		if (error instanceof McpCallerError) {
			return operationResult({ ok: false, error: error.message }, 400)
		}
		throw error
	}
	try {
		await softDeleteGrant({
			db: env.APP_DB,
			orgId: access.org.id,
			grantId: grant.id,
			audit: orgAuditWriterFromRequest(env, user.request),
		})
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unable to revoke that grant.'
		return operationResult({ ok: false, error: message }, 400)
	}
	return operationResult({ ok: true as const })
}
