import { expect, test } from 'vitest'
import {
	createMemoryHistory,
	createRouter,
	interpolatePath,
} from '@tanstack/react-router'
import { getRouteSegments } from '@tanstack/router-core'
import { QueryClient } from '@tanstack/react-query'
import { routeTree } from './routeTree.gen.ts'
import {
	orgResourcePathForAccountPath,
	orgSlugFromOrgOwnedPath,
} from '#universal/org-pages.ts'
const isOrgBoundPath = (path: string) => orgSlugFromOrgOwnedPath(path) !== null
const isLegacyAccountAlias = (path: string) =>
	orgResourcePathForAccountPath(
		path.replace(/^\/account\/connections(?=\/|$)/, '/account/agents'),
		'ghost',
	) !== null

/**
 * `/account/…` routes that share a name with an org section but are keyed by
 * something other than the request org. Every entry needs a reason; the walk
 * fails on entries that no longer match a route.
 */
const personScopedAccountRoutes: Record<string, string> = {
	'/account/memories-export.json': 'download binds an explicit org query',
	'/account/mcp-servers/logos/$serverId':
		'path has no org; handler binds via explicit server owner',
	'/account/mcp-servers/oauth/callback': 'OAuth state carries the server owner',
	'/account/packages/$packageId': 'package authorization checks its owner',
	'/account/packages/$packageId/approve-publish':
		'package authorization checks its owner',
	'/account/packages/$packageId/approve-capabilities':
		'package authorization checks its owner',
	'/account/packages/$packageId/files/$':
		'package authorization checks its owner',
	'/account/usage': 'redirects to personal org usage',
	'/account/credits': 'redirects to personal org credits ledger',
	'/account/credentials': 'redirects to signup org credentials',
}

type RouteEntry = {
	name: string
	method: string
	source: string
	href: string
}

const router = createRouter({
	routeTree,
	history: createMemoryHistory(),
	context: { queryClient: new QueryClient(), getCommittedPage: () => null },
})
function routeEntries(): Array<RouteEntry> {
	return Object.values(router.routesById)
		.filter((route) => route.id !== '__root__')
		.map((route) => {
			const source = route.fullPath
			const segments = getRouteSegments(route)
			if (!segments && source.includes('$'))
				throw new Error(`Missing compiled parameters for ${route.id}`)
			const params = Object.fromEntries(
				[...source.matchAll(/\$([A-Za-z]\w*)/g)].map(([, key]) => [
					key,
					key === 'orgSlug' ? 'ghost' : 'x',
				]),
			)
			return {
				name: source,
				source,
				method: 'ANY',
				// This inventories every template, including aliases whose empty-splat
				// sibling handles the same URL. Navigation destination selection is
				// covered separately by router-specificity tests.
				href: segments
					? interpolatePath(source, segments, { ...params, _splat: 'x' })
					: source,
			}
		})
}

/** Sections that have a `/@:orgSlug/-/<section>` page or API. */
function orgSectionsFromRouteTable(entries: Array<RouteEntry>) {
	const sections = new Set<string>()
	for (const { source } of entries) {
		const match = /^\/@\{\$orgSlug\}\/-\/([^/(.]+)/.exec(source)
		if (match?.[1]) sections.add(match[1])
	}
	return sections
}

/** `/account/<x>` routes whose first segment starts with an org section name. */
function accountRoutesNamedLikeOrgSections(entries: Array<RouteEntry>) {
	const sections = orgSectionsFromRouteTable(entries)
	return entries.filter(({ source }) => {
		const segment = /^\/account\/([^/(.]+)/.exec(source)?.[1]
		if (!segment) return false
		return [...sections].some((section) => segment.startsWith(section))
	})
}

/** Legacy `/-/packages` and `/-/connections` only 301 to the new names. */
const legacyOrgListRedirectRoutes = new Set([
	'/@{$orgSlug}/-/connections',
	'/@{$orgSlug}/-/connections/$',
	'/@{$orgSlug}/-/packages',
])

test('every org-scoped route in the route table is bound to its org', () => {
	const entries = routeEntries()
	const orgRoutes = entries.filter(({ source }) =>
		source.startsWith('/@{$orgSlug}/'),
	)
	expect(
		orgRoutes
			.filter(
				({ name, href }) =>
					!isOrgBoundPath(href) && !legacyOrgListRedirectRoutes.has(name),
			)
			.map((r) => r.name),
	).toEqual([])

	const accountRoutes = accountRoutesNamedLikeOrgSections(entries)
	const unclassified = accountRoutes
		.filter(
			({ name, href }) =>
				!isOrgBoundPath(href) &&
				!isLegacyAccountAlias(href) &&
				!(name in personScopedAccountRoutes),
		)
		.map(({ name }) => name)
	expect(unclassified).toEqual([])
	const accountRouteNames = new Set(accountRoutes.map(({ name }) => name))
	expect(
		Object.keys(personScopedAccountRoutes).filter(
			(name) => !accountRouteNames.has(name),
		),
	).toEqual([])
	expect(
		accountRoutes
			.filter(
				({ name, href }) =>
					name in personScopedAccountRoutes && isOrgBoundPath(href),
			)
			.map(({ name }) => name),
	).toEqual([])
})
