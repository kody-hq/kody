import { routes } from '#universal/routes.ts'

/**
 * 1Password skips offers to save or fill every field on a page when `<body>`
 * carries this attribute.
 *
 * @see https://developer.1password.com/docs/web/compatible-website-design/
 */
export const passwordManagerPageIgnoreAttribute = 'data-1p-ignore'

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

/** Props for `<body>`. Empty on login and signup. */
export function passwordManagerPageIgnoreProps(pathname: string) {
	if (!shouldIgnorePasswordManagerPage(pathname)) return {}
	return { [passwordManagerPageIgnoreAttribute]: true as const }
}
