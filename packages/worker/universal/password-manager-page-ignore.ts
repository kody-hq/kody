import { routes } from '#universal/routes.ts'

/**
 * The only documents where 1Password may offer to fill or save. Every other
 * pathname, including account, admin, and client navigations, opts out.
 */
const passwordManagerFillablePathnames = new Set<string>([
	routes.login.href(),
	routes.signup.href(),
])

/** True except on the login and signup documents. */
export function shouldIgnorePasswordManagerPage(pathname: string) {
	return !passwordManagerFillablePathnames.has(pathname)
}

export function pathnameFromAppUrl(url: string | undefined) {
	if (!url) return '/'
	try {
		return new URL(url, 'http://localhost').pathname
	} catch {
		return '/'
	}
}
