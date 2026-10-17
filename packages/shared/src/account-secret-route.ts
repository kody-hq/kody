type AccountSecretRouteScope = 'package' | 'session' | 'user'
const accountSecretsBasePath = '/account/secrets'
function secretPathSegment(value: string) {
	if (!value) throw new Error('Secret path identifiers cannot be empty.')
	return encodeURIComponent(value).replace(/\./g, '%2E')
}

export type AccountSecretRouteIdInput = {
	name: string
	scope: AccountSecretRouteScope
	packageId?: string | null
	sessionId?: string | null
}

export type ParsedAccountSecretRouteId = {
	name: string
	scope: AccountSecretRouteScope
	packageId: string | null
	sessionId: string | null
}

export type ParsedAccountSecretRoutePath = ParsedAccountSecretRouteId & {
	id: string
}

export function buildAccountSecretId(input: AccountSecretRouteIdInput) {
	const bindingId =
		input.scope === 'package'
			? (input.packageId ?? '')
			: input.scope === 'session'
				? (input.sessionId ?? '')
				: ''
	return `${input.scope}::${encodeURIComponent(bindingId)}::${encodeURIComponent(
		input.name,
	)}`
}

export function parseAccountSecretId(
	secretId: string,
): ParsedAccountSecretRouteId | null {
	const [scope, encodedBindingId, encodedName, ...rest] = secretId.split('::')
	if (rest.length > 0) return null
	if (scope !== 'package' && scope !== 'session' && scope !== 'user')
		return null

	try {
		const name = decodeURIComponent(encodedName ?? '')
		const bindingId = decodeURIComponent(encodedBindingId ?? '')
		if (!name.trim()) return null

		return {
			name,
			scope,
			packageId: scope === 'package' ? bindingId || null : null,
			sessionId: scope === 'session' ? bindingId || null : null,
		}
	} catch {
		return null
	}
}

export function buildAccountSecretPath(input: AccountSecretRouteIdInput) {
	if (input.scope === 'user') {
		return `${accountSecretsBasePath}/user/${secretPathSegment(input.name)}`
	}
	if (input.scope === 'package') {
		if (!input.packageId) {
			throw new Error(
				'packageId is required for package-scoped account secret paths',
			)
		}
		return `${accountSecretsBasePath}/package/${secretPathSegment(input.packageId)}/${secretPathSegment(input.name)}`
	}
	if (!input.sessionId) {
		throw new Error(
			'sessionId is required for session-scoped account secret paths',
		)
	}
	return `${accountSecretsBasePath}/session/${secretPathSegment(input.sessionId)}/${secretPathSegment(input.name)}`
}

/** Preserve already encoded path segments when attaching an origin. */
export function joinOriginAndEncodedPath(baseUrl: string, pathname: string) {
	return `${new URL(baseUrl).origin}${pathname}`
}

function accountSecretPathname(pathname: string) {
	const org = /^\/@[^/]+\/-\/secrets(\/.*)?$/.exec(pathname)
	if (!org) return pathname
	return `/account/secrets${org[1] ?? ''}`
}

export function parseAccountSecretPath(
	pathname: string,
): ParsedAccountSecretRoutePath | null {
	const segments = accountSecretPathname(pathname)
		.replace(/\/+$/, '')
		.split('/')
	if (segments.length === 0) return null

	const [empty, account, secrets, ...rest] = segments
	if (empty !== '' || account !== 'account' || secrets !== 'secrets') {
		return null
	}

	try {
		if (rest.length === 2 && rest[0] === 'user') {
			const parsed = {
				name: decodeURIComponent(rest[1] ?? ''),
				scope: 'user' as const,
				packageId: null,
				sessionId: null,
			}
			if (!parsed.name.trim()) return null
			const id = buildAccountSecretId(parsed)
			return { ...parsed, id }
		}
		if (rest.length === 3 && rest[0] === 'package') {
			const parsed = {
				name: decodeURIComponent(rest[2] ?? ''),
				scope: 'package' as const,
				packageId: decodeURIComponent(rest[1] ?? '') || null,
				sessionId: null,
			}
			if (!parsed.name.trim() || !parsed.packageId) return null
			const id = buildAccountSecretId(parsed)
			return { ...parsed, id }
		}
		if (rest.length === 3 && rest[0] === 'session') {
			const parsed = {
				name: decodeURIComponent(rest[2] ?? ''),
				scope: 'session' as const,
				packageId: null,
				sessionId: decodeURIComponent(rest[1] ?? '') || null,
			}
			if (!parsed.name.trim() || !parsed.sessionId) return null
			const id = buildAccountSecretId(parsed)
			return { ...parsed, id }
		}
		return null
	} catch {
		return null
	}
}
