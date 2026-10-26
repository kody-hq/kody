import {
	scopesIncludeEmail,
	visitorNeedKeysOfScopes,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'

/**
 * Plain-language claims for the package-app OAuth consent page.
 * Keep these readable; raw scope strings stay in the collapsed Details.
 */
export function packageAppOauthClaimLabels(
	scopes: ReadonlyArray<PackageAppOauthScope | string>,
	/** The app's own words for each `need:<key>` it asks for. */
	visitorNeedDescriptions: Readonly<Record<string, string>> = {},
) {
	const claims = [
		'See your name, username, and avatar',
		'See your access level for this app',
	]
	if (scopesIncludeEmail(scopes)) {
		claims.push('See your email address')
	}
	for (const key of visitorNeedKeysOfScopes(scopes)) {
		const description = Object.hasOwn(visitorNeedDescriptions, key)
			? visitorNeedDescriptions[key]
			: undefined
		claims.push(`Use your own data or credentials: ${description ?? key}`)
	}
	return claims
}

export function packageAppOauthClaimLabel(
	scope: PackageAppOauthScope | string,
	visitorNeedDescriptions: Readonly<Record<string, string>> = {},
) {
	if (scope === 'profile') return 'See your name, username, and avatar'
	if (scope === 'email') return 'See your email address'
	const key = visitorNeedKeysOfScopes([scope])[0]
	if (!key) return scope
	const description = Object.hasOwn(visitorNeedDescriptions, key)
		? visitorNeedDescriptions[key]
		: undefined
	return `Use your own data or credentials: ${description ?? key}`
}

export function packageAppOauthAppDomain(redirectUri: string) {
	try {
		return new URL(redirectUri).hostname
	} catch {
		return null
	}
}
