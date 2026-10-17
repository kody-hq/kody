import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { documentDestinationHeader } from '../session-identity.ts'

/** Presentation routes can share data without sharing their login return URL. */
export function accountReturnLocation(request: Request, fallback: string) {
	const url = new URL(request.url)
	const destination =
		normalizeRedirectTo(request.headers.get(documentDestinationHeader)) ??
		`${url.pathname}${url.search}${url.hash}`
	const pathname = new URL(destination, url).pathname
	return /^\/account(?:\/|$)/.test(pathname) ? destination : fallback
}
