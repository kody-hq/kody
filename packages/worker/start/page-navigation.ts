import type { WorkspaceSwitchTarget } from '#universal/org-pages.ts'
/** Presentation identity belongs to the native route, never a second URL matcher. */
const pageNavigationItems = [
	'activity',
	'agents',
	'approvals',
	'billing',
	'codemods',
	'collaborators',
	'community-reports',
	'connected-apps',
	'connections',
	'credentials',
	'credits',
	'data',
	'email',
	'execution-contexts',
	'experiments',
	'feature-flags',
	'files',
	'follows',
	'grants',
	'insights',
	'integrations',
	'jobs',
	'members',
	'memories',
	'organizations',
	'overview',
	'packages',
	'platform-feedback',
	'platform-integrations',
	'profile',
	'profiles',
	'provider-marks',
	'public-profile',
	'apps',
	'repositories',
	'reserved-usernames',
	'roles',
	'secret-providers',
	'security',
	'settings',
	'skills',
	'system-email',
	'teams',
	'usage',
	'users',
	'orgs',
	'waiting',
	'webhooks',
	'workflows',
] as const
export type PageNavigation = {
	rail: 'account' | 'workspace' | 'admin'
	item: (typeof pageNavigationItems)[number]
}
type RouteNavigation = PageNavigation & {
	/** Search param whose value, when it names a rail item, replaces `item`. */
	itemFromSearch?: string
}
function isPageNavigationItem(value: unknown): value is PageNavigation['item'] {
	return (pageNavigationItems as ReadonlyArray<unknown>).includes(value)
}
export type MatchedPageNavigation = PageNavigation & {
	workspaceSwitch?: WorkspaceSwitchTarget
	orgSlug: string | null
	profileSlug?: string
}
declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		navigation?: RouteNavigation
		workspaceSwitch?: WorkspaceSwitchTarget & {
			suffix?: readonly (string | { param: string })[]
		}
	}
}
export function pageNavigationForMatches(
	matches: readonly {
		staticData: {
			navigation?: RouteNavigation
			workspaceSwitch?: WorkspaceSwitchTarget & {
				suffix?: readonly (string | { param: string })[]
			}
		}
		params: unknown
		search?: unknown
	}[],
): MatchedPageNavigation | undefined {
	for (const match of [...matches].reverse()) {
		if (!match.staticData.navigation) continue
		const { itemFromSearch, ...navigation } = match.staticData.navigation
		const searchItem = itemFromSearch
			? (match.search as Record<string, unknown> | undefined)?.[itemFromSearch]
			: undefined
		if (isPageNavigationItem(searchItem)) navigation.item = searchItem
		const params = (match.params ?? {}) as {
			orgSlug?: unknown
			username?: unknown
		}
		const target = match.staticData.workspaceSwitch
		const values = (match.params ?? {}) as Record<string, unknown>
		const rest = target?.suffix
			?.map((segment) => {
				if (typeof segment === 'string') return segment
				const value = values[segment.param]
				if (typeof value !== 'string')
					throw new Error(
						`Missing workspace switch parameter: ${segment.param}`,
					)
				return encodeURIComponent(value)
			})
			.join('/')
		return {
			...navigation,
			...(target ? { workspaceSwitch: { section: target.section, rest } } : {}),
			orgSlug: typeof params.orgSlug === 'string' ? params.orgSlug : null,
			...(typeof params.username === 'string'
				? { profileSlug: params.username }
				: {}),
		}
	}
	return undefined
}
