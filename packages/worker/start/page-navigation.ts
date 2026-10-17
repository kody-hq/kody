import { type WorkspaceSwitchTarget } from '#universal/org-pages.ts'
/** Presentation identity belongs to the native route, never a second URL matcher. */
export type PageNavigation = {
	rail: 'account' | 'workspace' | 'admin'
	item:
		| 'activity'
		| 'agents'
		| 'approvals'
		| 'billing'
		| 'codemods'
		| 'collaborators'
		| 'community-reports'
		| 'connections'
		| 'credentials'
		| 'credits'
		| 'data'
		| 'email'
		| 'experiments'
		| 'feature-flags'
		| 'follows'
		| 'grants'
		| 'insights'
		| 'jobs'
		| 'members'
		| 'memories'
		| 'organizations'
		| 'overview'
		| 'packages'
		| 'platform-feedback'
		| 'platform-integrations'
		| 'profile'
		| 'provider-marks'
		| 'repositories'
		| 'reserved-usernames'
		| 'roles'
		| 'secret-providers'
		| 'security'
		| 'settings'
		| 'system-email'
		| 'teams'
		| 'usage'
		| 'users'
		| 'waiting'
		| 'webhooks'
		| 'workflows'
}
export type MatchedPageNavigation = PageNavigation & {
	workspaceSwitch?: WorkspaceSwitchTarget
	orgSlug: string | null
	profileSlug?: string
}
declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		navigation?: PageNavigation
		workspaceSwitch?: WorkspaceSwitchTarget & {
			suffix?: readonly (string | { param: string })[]
		}
	}
}
export function pageNavigationForMatches(
	matches: readonly {
		staticData: {
			navigation?: PageNavigation
			workspaceSwitch?: WorkspaceSwitchTarget & {
				suffix?: readonly (string | { param: string })[]
			}
		}
		params: unknown
	}[],
): MatchedPageNavigation | undefined {
	for (const match of [...matches].reverse()) {
		const navigation = match.staticData.navigation
		if (!navigation) continue
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
