import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	AuthorizationError,
	authorize,
	canSeeResource,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { loadConnectionUsage } from '#worker/usage/connection-usage.ts'

/**
 * Org-wide usage (other people, Automation) is billing data: owners and
 * billing admins see it. Everyone else sees only their own connections.
 */
async function canReadOrgWideUsage(
	env: Env,
	request: Parameters<typeof authorize>[0]['request'],
) {
	try {
		await authorize({ env, request }, 'billing:read')
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}

export async function loadAccountConnectionUsageData({
	env,
	user,
}: {
	env: Env
	user: AuthenticatedAppUser
}) {
	const orgId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	const access = await computeEffectivePermissions({
		env,
		request: user.request,
	})
	return loadConnectionUsage({
		env,
		orgId,
		orgSlug: user.request.org.slug ?? user.username,
		viewerPersonId: user.mcpUser.userId,
		includeOrgWide: await canReadOrgWideUsage(env, user.request),
		canSeePackage: (packageId) =>
			canSeeResource(access, packageResource({ id: packageId, userId: orgId })),
	})
}
