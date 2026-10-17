import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	decodeCreditLedgerCursor,
	loadOrgCreditsData,
} from '#app/org-credits-data.ts'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

/** The caller supplies a context bound to the explicitly authorized organization. */
export async function loadAuthorizedOrgCredits({
	env,
	user,
	cursor,
}: {
	env: Env
	user: AuthenticatedAppUser
	cursor?: string | null
}) {
	let canReadBilling = true
	try {
		await authorize({ env, request: user.request }, 'billing:read')
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		canReadBilling = false
	}
	const record = await getOrgById(env.APP_DB, user.request.org.id)
	if (!record) return null
	return loadOrgCreditsData({
		env,
		org: {
			id: user.request.org.id,
			slug: record.slug,
			displayName: record.display_name,
			personal: user.request.org.id === personalOrgIdForPerson(user.mcpUser),
		},
		viewerUserId: user.mcpUser.userId,
		canReadBilling,
		before: decodeCreditLedgerCursor(cursor ?? null),
	})
}
