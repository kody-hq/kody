/**
 * Cache headers on package-app responses.
 *
 * Kody does not cache app content; the app's own `Cache-Control` decides.
 * What Kody must guarantee is that a response rendered for one signed-in
 * visitor never reaches another visitor through a shared cache, so:
 *
 * - a response served to a signed-in visitor is downgraded to `private`
 *   (dropping `public`, `s-maxage`, and `proxy-revalidate`) unless the app
 *   already said `private` or `no-store`. Browser caching (`max-age`,
 *   `immutable`, validators) stays as the app wrote it.
 * - every package-app response varies on `Cookie`, so a cache never hands an
 *   anonymous variant to a signed-in visitor or the reverse.
 *
 * WebSocket upgrades are returned untouched (their headers are immutable).
 */
export type PackageAppAudience = 'signed-in' | 'anonymous'

const sharedCacheDirectives = new Set([
	'public',
	's-maxage',
	'proxy-revalidate',
])

function directiveName(directive: string) {
	return directive.split('=')[0]?.trim().toLowerCase() ?? ''
}

export function privateCacheControl(value: string | null): string {
	const directives = (value ?? '')
		.split(',')
		.map((directive) => directive.trim())
		.filter(Boolean)
	const names = new Set(directives.map(directiveName))
	if (names.has('no-store') || names.has('private')) {
		return directives
			.filter(
				(directive) => !sharedCacheDirectives.has(directiveName(directive)),
			)
			.join(', ')
	}
	return [
		'private',
		...directives.filter(
			(directive) => !sharedCacheDirectives.has(directiveName(directive)),
		),
	].join(', ')
}

export function appendPackageAppVary(headers: Headers, field: string) {
	const existing = headers.get('Vary')
	if (!existing) {
		headers.set('Vary', field)
		return
	}
	const fields = existing.split(',').map((entry) => entry.trim().toLowerCase())
	if (fields.includes('*') || fields.includes(field.toLowerCase())) return
	headers.set('Vary', `${existing}, ${field}`)
}

export function applyPackageAppCacheHeaders(
	response: Response,
	audience: PackageAppAudience,
): Response {
	if (response.webSocket || response.status === 101) return response
	const headers = new Headers(response.headers)
	if (audience === 'signed-in') {
		headers.set(
			'Cache-Control',
			privateCacheControl(headers.get('Cache-Control')),
		)
	}
	appendPackageAppVary(headers, 'Cookie')
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}
