import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { buildOrgAvatarUrl } from '#worker/orgs/org-avatar.ts'
import { getOrgById, loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type OrgRole } from '@kody-internal/shared/request-context.ts'

export type ManagedOrg = {
	id: OwnerId
	slug: string
	displayName: string | null
	avatarUrl: string | null
	personal: boolean
	role: OrgRole
}

export type OrgManagementAccess =
	| { ok: true; org: ManagedOrg }
	| { ok: false; status: 403 | 404; error: string }

/**
 * The organization a `/@slug/-/settings`, `/@slug/-/members`, teams, grants, or
 * collaborators request acts on, when the person may use `permission` there.
 * `authorize` is the same check MCP capabilities run. A slug the person cannot
 * reach is a 404. Grant-only collaborators are also a 404 — these pages are for
 * members.
 */
export async function resolveOrgManagementAccess(input: {
	request: Request
	orgSlug?: string
	env: Env
	user: AuthenticatedAppUser
	permission: Extract<
		OrgPermission,
		| 'org:read'
		| 'org:write'
		| 'org:delete'
		| 'member:read'
		| 'member:write'
		| 'member:delete'
		| 'team:read'
		| 'team:write'
		| 'team:delete'
	>
}): Promise<OrgManagementAccess> {
	const resolution = input.orgSlug
		? ((await loadOrgBindingForSlug(
				input.env.APP_DB,
				input.user.mcpUser.userId,
				input.orgSlug,
			)) ?? 'denied')
		: await loadRequestOrgResolution(
				input.request,
				input.env,
				input.user.mcpUser.userId,
			)
	if (typeof resolution === 'string' || resolution.role === null) {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	// `user.request` is bound from the same URL in readAuthenticatedAppUser.
	// Refuse if a caller ever passes a mismatched request/user pair so
	// authorize cannot check one org and mutate another.
	if (resolution.org.id !== input.user.request.org.id) {
		return { ok: false, status: 404, error: 'Organization unavailable.' }
	}
	try {
		await authorize(
			{ env: input.env, request: input.user.request },
			input.permission,
		)
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return {
			ok: false,
			status: 403,
			error: 'You do not have permission to do that in this organization.',
		}
	}
	const record = await getOrgById(input.env.APP_DB, resolution.org.id)
	if (!record) {
		throw new Error(`Cannot load organization ${resolution.org.id}.`)
	}
	const slug = record.slug
	return {
		ok: true,
		org: {
			id: resolution.org.id,
			slug,
			displayName: record.display_name,
			avatarUrl: buildOrgAvatarUrl({
				slug,
				avatarKey: record.avatar_key,
			}),
			personal: await isPersonalOrg(input.env.APP_DB, resolution.org.id),
			role: resolution.role,
		},
	}
}

export async function orgHasPermission(
	env: Env,
	user: AuthenticatedAppUser,
	permission: Extract<
		OrgPermission,
		| 'org:read'
		| 'org:write'
		| 'org:delete'
		| 'member:read'
		| 'member:write'
		| 'member:delete'
		| 'team:read'
		| 'team:write'
		| 'team:delete'
	>,
) {
	try {
		await authorize({ env, request: user.request }, permission)
		return true
	} catch (error) {
		if (error instanceof AuthorizationError) return false
		throw error
	}
}
