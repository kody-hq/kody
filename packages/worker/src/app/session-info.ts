import { loadAccountOrganizationSnapshot } from '#app/account-organizations-data.ts'
import { destroyAuthCookie, isSecureRequest } from '#app/auth-session.ts'
import { buildUserAvatarUrl } from '#app/community-public.ts'
import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import {
	loadRequestFeatureFlags,
	type EvaluatedFeatureFlags,
} from '#app/request-feature-flags-cache.ts'
import { type EmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import { type AccountOrganizationSummary } from '#universal/loader-data.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'

export type SessionInfo = {
	email: string
	emailVerified: boolean
	emailVerificationDelivery: EmailVerificationDelivery | null
	username: string
	avatarUrl: string | null
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	featureFlags: EvaluatedFeatureFlags
	organizations: Array<AccountOrganizationSummary>
	inviteCount: number
}

export type LoadedSessionResult = {
	session: SessionInfo | null
	setCookie?: string | undefined
}

export async function loadSessionInfo(
	request: Request,
	env: Env,
	/** Page path when it differs from `request.url`; supplies flag org context. */
	pathname?: string,
): Promise<LoadedSessionResult> {
	const resolved = await loadResolvedRequestAuth(request, env)
	// Suspended and deleting accounts are signed out in the SSR shell
	// (matching readAuthenticatedAppUser). Soft-deleted people never resolve
	// as `user` (request-auth-cache destroys the cookie). Deleting also clears
	// the cookie so /login does not bounce back to /account.
	if (
		!resolved.user ||
		resolved.user.accountSuspended ||
		resolved.user.accountDeleting
	) {
		return {
			session: null,
			setCookie: resolved.user?.accountDeleting
				? await destroyAuthCookie(isSecureRequest(request))
				: resolved.setCookie,
		}
	}

	const featureFlags = await loadRequestFeatureFlags(
		request,
		env,
		{
			userId: resolved.user.userId,
			stableUserId: resolved.user.mcpUser.userId,
		},
		pathname,
	)
	const organizations = await loadAccountOrganizationSnapshot(
		env,
		resolved.user,
	)

	return {
		session: {
			email: resolved.user.email,
			emailVerified: resolved.user.emailVerified,
			emailVerificationDelivery: resolved.user.emailVerificationDelivery,
			username: resolved.user.username,
			avatarUrl: buildUserAvatarUrl({
				username: resolved.user.username,
				avatarKey: resolved.user.avatarKey,
			}),
			roles: resolved.user.roles,
			permissions: resolved.user.permissions,
			featureFlags,
			organizations: organizations.organizations,
			inviteCount: organizations.inviteCount,
		},
		setCookie: resolved.setCookie,
	}
}
