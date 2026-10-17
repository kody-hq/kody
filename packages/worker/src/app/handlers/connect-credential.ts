import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { orgCredentialCreatePath } from '#universal/credential-contracts.ts'

/** The signup org's creation page, keeping `search` (including its `?`). */
export function signupOrgCredentialCreateHref(
	user: Pick<AuthenticatedAppUser, 'request' | 'username'>,
	search: string,
) {
	const requestedOrg = new URLSearchParams(search).get('org')?.trim()
	const slug = requestedOrg || user.request.org.slug || user.username
	return `${orgCredentialCreatePath(slug)}${search}`
}
