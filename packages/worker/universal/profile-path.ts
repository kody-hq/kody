import { dnsSafeUsernamePatternSource } from '@kody-internal/shared/public-urls.ts'

/**
 * `/@slug/-/repositories` is the signed-in repository list. The capture is
 * {@link dnsSafeUsernamePatternSource}, the same handle shape as usernames.
 */
const orgRepositoryListPattern = new RegExp(
	`^/@(${dnsSafeUsernamePatternSource})/-/repositories/?$`,
)

/**
 * Username for `/@username` only. The `/@owner/…` namespace also holds the
 * canonical package URL, and reading `kentcdodds/devin` as a username would
 * render a profile page for it.
 */
export function getProfileUsernameFromPathname(pathname: string) {
	const matched = /^\/@([^/]+)\/?$/.exec(pathname)?.[1]
	if (matched) {
		try {
			return decodeURIComponent(matched)
		} catch {
			return null
		}
	}
	return orgRepositoryListPattern.exec(pathname)?.[1] ?? null
}

export function isProfilePathname(pathname: string) {
	return getProfileUsernameFromPathname(pathname) != null
}
