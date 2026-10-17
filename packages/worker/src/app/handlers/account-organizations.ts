import { loadAccountOrganizationSnapshot } from '#app/account-organizations-data.ts'
import { loadAccountProfileData } from '#app/account-profile-data.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type AccountOrganizationsLoaderData } from '#universal/loader-data.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import { FreeOrgLimitError } from '#worker/orgs/billing.ts'
import { createOrganization } from '#worker/orgs/create-organization.ts'
import {
	loadRestorableOrganizationBySlugForPerson,
	OrgRestoreWindowExpiredError,
	restoreOrg,
} from '#worker/orgs/soft-delete.ts'
import { normalizeUsername } from '#worker/identity/username.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'

export async function loadAccountOrganizationsData(
	env: Env,
	user: AuthenticatedAppUser,
): Promise<AccountOrganizationsLoaderData> {
	const [snapshot, profile] = await Promise.all([
		loadAccountOrganizationSnapshot(env, user, { includeRestorable: true }),
		loadAccountProfileData(user, env),
	])
	return {
		ok: true,
		username: profile.username,
		viewer: { displayName: profile.displayName, avatarUrl: profile.avatarUrl },
		organizations: snapshot.organizations,
		restorableOrganizations: snapshot.restorableOrganizations,
		pendingInvites: snapshot.pendingInvites,
	}
}

export async function createWebsiteOrganization({
	env,
	user,
	displayName,
	slug,
}: {
	env: Env
	user: AuthenticatedAppUser
	displayName: string
	slug: string
}) {
	try {
		await authorize({ env, request: user.request }, 'org:write')
	} catch (error) {
		if (error instanceof AuthorizationError)
			throw new Error('You do not have permission to create an organization.')
		throw error
	}
	const result = await createOrganization(env.APP_DB, env, {
		personId: user.mcpUser.userId,
		audit: orgAuditWriterFromRequest(env, user.request),
		displayName,
		slug,
	})
	if (!result.ok) {
		if (result.restorableSlug)
			return {
				ok: false as const,
				error: result.error,
				restorableSlug: result.restorableSlug,
			}
		throw new Error(result.error)
	}
	return { ok: true as const, slug: result.slug }
}

/** Only an Owner at the deletion generation can restore the reserved handle. */
export async function restoreWebsiteOrganization(input: {
	env: Env
	user: AuthenticatedAppUser
	orgSlug: string
}) {
	const slug = normalizeUsername(input.orgSlug)
	const restorable = slug
		? await loadRestorableOrganizationBySlugForPerson({
				db: input.env.APP_DB,
				actorUserId: input.user.mcpUser.userId,
				slug,
			})
		: null
	if (!restorable)
		throw new Error(
			'That organization is not available to restore. The 30-day window may have ended, or you were not an Owner when it was deleted.',
		)
	try {
		await restoreOrg({
			env: input.env,
			orgId: restorable.orgId,
			actorUserId: input.user.mcpUser.userId,
			actorUsername: input.user.username,
		})
	} catch (error) {
		if (error instanceof OrgRestoreWindowExpiredError)
			throw new Error(
				'The 30-day restore window for this organization has expired.',
			)
		if (error instanceof FreeOrgLimitError) throw new Error(error.message)
		if (
			error instanceof Error &&
			(error.message === 'org_restore_race' ||
				error.message === 'org_not_deleted')
		)
			throw new Error(
				'That organization was already restored. Refresh and try again.',
			)
		throw error
	}
	return { slug: restorable.slug }
}
