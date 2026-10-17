/**
 * Agents page views (`/@slug/-/agents`, aliased as `/account/agents`). The page is one payload
 * (`/account/connected-agents.json`) rendered four exclusive ways: the
 * connected list, the full client grid on `/new` (Add connection), one
 * host's install steps on `/new/:agent`, and per-connection usage on
 * `/usage` (which also reads `/account/connection-usage.json`). The add and
 * usage views are their own pages, not nested chrome on the list.
 */

import {
	type McpClientKind,
	isMcpClientKind,
	mcpClientTabs,
} from '#universal/onboarding-mcp-clients.ts'
import { orgResourcePath, orgSlugFromPathname } from '#universal/org-pages.ts'
export type AccountConnectionsView =
	| { kind: 'list' }
	| { kind: 'new'; agent: McpClientKind | null }
	| { kind: 'usage' }

/**
 * Every named client, in catalog order, with no viewport split and nothing
 * folded under Not listed: the account page is where someone adds a second
 * or third host, so the phone-vs-desktop guess onboarding makes does not
 * apply. The generic MCP URL path is rendered below the grid instead of as
 * an `other` card.
 */
export const accountConnectionAgentIds: ReadonlyArray<McpClientKind> =
	mcpClientTabs.map((tab) => tab.id).filter((id) => id !== 'other')

export function isAccountConnectionAgent(
	value: string | null | undefined,
): value is McpClientKind {
	return isMcpClientKind(value) && value !== 'other'
}

/**
 * List and add URLs stay under `/@slug/…` when the person is already on an
 * org resource page, so Add / View steps / back do not bounce through
 * `/account/…` redirects (or stay on `/account` after a client navigation).
 */
export function accountConnectionsListHref(pathname?: string | null) {
	const slug = pathname ? orgSlugFromPathname(pathname) : null
	return slug ? orgResourcePath(slug, 'agents') : '/account/agents'
}

export function accountConnectionsNewHref(
	agent: McpClientKind | null,
	pathname?: string | null,
) {
	const slug = pathname ? orgSlugFromPathname(pathname) : null
	if (slug) {
		return orgResourcePath(slug, 'agents', agent ? `new/${agent}` : 'new')
	}
	if (!agent) return '/account/agents/new'
	return `/account/agents/new/${encodeURIComponent(agent)}`
}

/**
 * Usage drill-in. `connection` (a `ConnectionUsageEntry.id`) narrows it to
 * one connection.
 */
export function accountConnectionsUsageHref(
	pathname?: string | null,
	connection?: string | null,
) {
	const slug = pathname ? orgSlugFromPathname(pathname) : null
	const base = slug
		? orgResourcePath(slug, 'agents', 'usage')
		: '/account/agents/usage'
	return connection
		? `${base}?connection=${encodeURIComponent(connection)}`
		: base
}
