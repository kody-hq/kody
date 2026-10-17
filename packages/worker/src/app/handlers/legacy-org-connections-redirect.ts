import { orgResourcePath } from '#universal/org-pages.ts'

/**
 * `/@slug/-/connections(/…)` renamed to `/@slug/-/agents(/…)`. Keep
 * permanent redirects so bookmarks, emails, and agent-printed links keep
 * working; the rest of the path and the query survive.
 */
export function resolveLegacyOrgConnectionsLocation(url: URL): string | null {
	const match = /^\/@([^/]+)\/-\/connections(?:\/(.*))?$/.exec(url.pathname)
	if (!match) return null
	return `${orgResourcePath(match[1] ?? '', 'agents', match[2])}${url.search}`
}
