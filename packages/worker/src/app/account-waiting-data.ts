import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import type { AccountWaitingLoaderData } from '#universal/loader-data.ts'
import { deriveWaitingItems } from '#mcp/waiting/derive-waiting.ts'
import { listPendingInvitesForViewer } from '#app/account-organizations-data.ts'
import type { readAuthenticatedAppUser } from '#app/authenticated-user.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export async function loadAccountWaitingData(input: {
	env: Env
	user: AuthenticatedUser
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<AccountWaitingLoaderData> {
	const orgSlug =
		input.user.request.org.slug?.trim() || input.user.username.trim()
	if (!orgSlug) {
		throw new Error('Waiting links need the signup organization slug.')
	}
	const [items, invites] = await Promise.all([
		deriveWaitingItems({
			env: input.env,
			user: {
				userId: input.user.userId,
				stableUserId: ownerIdFromCaller({
					request: input.user.request,
					user: input.user.mcpUser,
				}),
				actorStableUserId: personalOrgIdForPerson(input.user.mcpUser),
				email: input.user.email,
				username: input.user.username,
				emailVerified: input.user.emailVerified,
			},
			orgSlug,
			now: input.now,
			waitUntil: input.waitUntil,
		}),
		listPendingInvitesForViewer(input.env, input.user),
	])
	return {
		ok: true,
		items,
		invites,
	}
}
