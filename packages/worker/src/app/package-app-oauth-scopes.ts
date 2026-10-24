import { packageAppVisitorNeedKeyPattern } from '#worker/package-registry/types.ts'

/** Default claims always included; `email` is opt-in and needs consent. */
export const packageAppOauthDefaultScopes = ['profile'] as const
export const packageAppOauthOptionalScopes = ['email'] as const

/** One consent scope per `kody.app.visitorNeeds` key. */
export const packageAppVisitorNeedScopePrefix = 'need:'

export type PackageAppVisitorNeedScope =
	`${typeof packageAppVisitorNeedScopePrefix}${string}`

export type PackageAppOauthScope =
	| (typeof packageAppOauthDefaultScopes)[number]
	| (typeof packageAppOauthOptionalScopes)[number]
	| PackageAppVisitorNeedScope

const optionalSet = new Set<string>(packageAppOauthOptionalScopes)

export function packageAppVisitorNeedScope(
	key: string,
): PackageAppVisitorNeedScope {
	return `${packageAppVisitorNeedScopePrefix}${key}`
}

/** The visitor need key a scope names, or null when it is not a need scope. */
export function visitorNeedKeyOfScope(scope: string): string | null {
	if (!scope.startsWith(packageAppVisitorNeedScopePrefix)) return null
	const key = scope.slice(packageAppVisitorNeedScopePrefix.length)
	return packageAppVisitorNeedKeyPattern.test(key) ? key : null
}

/** A known scope string, or null for anything else. */
export function readPackageAppOauthScope(
	raw: string,
): PackageAppOauthScope | null {
	if (raw === 'profile' || optionalSet.has(raw)) {
		return raw as PackageAppOauthScope
	}
	const key = visitorNeedKeyOfScope(raw)
	return key ? packageAppVisitorNeedScope(key) : null
}

export function parsePackageAppOauthScopes(raw: string | null | undefined): {
	scopes: Array<PackageAppOauthScope>
	error: string | null
} {
	const requested = (raw ?? '')
		.split(/[\s+,]+/)
		.map((part) => part.trim().toLowerCase())
		.filter((part) => part.length > 0)
	const scopes = new Set<PackageAppOauthScope>(packageAppOauthDefaultScopes)
	for (const part of requested) {
		if (part === 'openid') continue
		const scope = readPackageAppOauthScope(part)
		if (scope) {
			scopes.add(scope)
			continue
		}
		return {
			scopes: [...packageAppOauthDefaultScopes],
			error: `Unsupported scope: ${part}`,
		}
	}
	return { scopes: [...scopes], error: null }
}

export function scopesIncludeEmail(scopes: ReadonlyArray<string>) {
	return scopes.includes('email')
}

export function visitorNeedKeysOfScopes(
	scopes: ReadonlyArray<string>,
): Array<string> {
	return scopes.flatMap((scope) => {
		const key = visitorNeedKeyOfScope(scope)
		return key ? [key] : []
	})
}

export function serializePackageAppOauthScopes(
	scopes: ReadonlyArray<PackageAppOauthScope>,
) {
	return [...new Set(scopes)].sort().join(' ')
}
