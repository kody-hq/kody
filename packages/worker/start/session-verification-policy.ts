import { isPublicDocSlug } from './page-access.ts'

export type SessionVerificationPolicy = 'required' | 'public' | 'public-doc'
declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		sessionVerification?: SessionVerificationPolicy
	}
}
type VerificationMatch = {
	staticData: { sessionVerification?: SessionVerificationPolicy }
	params: unknown
	globalNotFound?: boolean
}

/** Only the destination route may opt out. Parent public layouts do not grant access. */
export function requiresSessionVerification(
	matches: ReadonlyArray<VerificationMatch>,
) {
	if (matches.some((match) => match.globalNotFound)) return true
	const match = matches.at(-1)
	switch (match?.staticData.sessionVerification) {
		case 'public':
			return false
		case 'public-doc':
			return (
				!match.params ||
				typeof match.params !== 'object' ||
				!('slug' in match.params) ||
				typeof match.params.slug !== 'string' ||
				!isPublicDocSlug(match.params.slug)
			)
		default:
			return true
	}
}
