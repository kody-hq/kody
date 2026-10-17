import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getOrgById } from '#worker/orgs/repo.ts'

/**
 * Legacy `/account/usage` → personal-org `/@slug/-/usage`, keeping the query
 * so Stripe top-up returns (`?topup=success&session_id=…`) and notice codes
 * still resolve on the org usage page. The browser re-applies `#credits`.
 */
export async function personalUsageSlug(env: Env, user: AuthenticatedAppUser) {
	const signupOrg = await getOrgById(
		env.APP_DB,
		personalOrgIdForPerson(user.mcpUser),
	)
	return signupOrg?.slug?.trim() || user.username
}
