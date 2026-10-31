import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { setAuthSessionSecret } from '#app/auth-session.ts'
import { getEnv } from '#app/env.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'

const meHandlePathPattern = /^\/(?:@|%40)me(?=\/|$)/i

/** True for `/@me` and anything under `/@me/` (any letter case). */
export function isMeHandlePath(pathname: string) {
	return meHandlePathPattern.test(pathname)
}

/**
 * Swap the leading `/@me` for the person's own handle. Keeps the rest of the
 * path and the query string; browsers re-apply the fragment to a redirect.
 */
export function resolveMeHandleHref(url: URL, handle: string) {
	const rest = url.pathname.replace(meHandlePathPattern, '')
	return `/@${encodeURIComponent(handle.toLowerCase())}${rest}${url.search}`
}

const privateRedirectHeaders = {
	'Cache-Control': 'private, no-store',
	'CDN-Cache-Control': 'no-store',
	'Cloudflare-CDN-Cache-Control': 'no-store',
	Vary: 'Cookie',
}

function privateRedirect(location: string, setCookie: string | undefined) {
	const headers = new Headers(privateRedirectHeaders)
	headers.set('Location', location)
	if (setCookie) headers.set('Set-Cookie', setCookie)
	return new Response(null, { status: 302, headers })
}

/**
 * `/@me/...` is a per-person alias for easy settings links. Signed-out
 * visitors sign in first with `redirectTo` kept on `/@me/...`, which then
 * resolves here. Never cacheable: the target depends on the session cookie.
 */
export async function handleMeHandleRedirect(
	request: Request,
	env: Env,
	url: URL = new URL(request.url),
): Promise<Response | null> {
	if (!isMeHandlePath(url.pathname)) return null
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { ...privateRedirectHeaders, Allow: 'GET, HEAD' },
		})
	}
	setAuthSessionSecret(getEnv(env).COOKIE_SECRET)
	const auth = await loadResolvedRequestAuth(request, env)
	const user = auth.user
	if (!user || user.accountSuspended || user.accountDeleting) {
		const loginUrl = new URL('/login', url)
		const redirectTo = normalizeRedirectTo(`${url.pathname}${url.search}`)
		if (redirectTo) loginUrl.searchParams.set('redirectTo', redirectTo)
		return privateRedirect(
			`${loginUrl.pathname}${loginUrl.search}`,
			auth.setCookie,
		)
	}
	return privateRedirect(
		resolveMeHandleHref(url, user.username),
		auth.setCookie,
	)
}
