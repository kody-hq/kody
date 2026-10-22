import { type SessionInfo } from '#client/session.ts'
import { appShellForMatches, type AppShell } from './app-shell.ts'
import { pageNavigationForMatches } from './page-navigation.ts'

type WorkspaceLayoutPolicy = 'private' | 'profile' | 'resource'
declare module '@tanstack/router-core' {
	interface StaticDataRouteOption {
		workspaceLayout?: WorkspaceLayoutPolicy
	}
}

type LayoutMatch = Parameters<typeof pageNavigationForMatches>[0][number] & {
	status?: string
	staticData: {
		workspaceLayout?: WorkspaceLayoutPolicy
		shell?: Partial<AppShell>
	}
}

/** Presentation only. Each existing loader still authorizes its own resource. */
export function workspaceLayoutNavigation(
	matches: readonly LayoutMatch[],
	session: Pick<SessionInfo, 'username' | 'organizations'> | null,
) {
	if (
		!session ||
		appShellForMatches(matches).mode !== 'standard' ||
		matches.some(
			(match) => match.status === 'error' || match.status === 'notFound',
		)
	)
		return null
	const policy = [...matches]
		.reverse()
		.find((match) => match.staticData.workspaceLayout)
		?.staticData.workspaceLayout
	if (!policy) return null
	const navigation = pageNavigationForMatches(matches)
	if (policy === 'private') return navigation ?? null
	const params = matches.at(-1)?.params
	if (!params || typeof params !== 'object' || !('username' in params))
		return null
	const username = params.username
	if (typeof username !== 'string') return null
	const org = session.organizations?.find((entry) => entry.slug === username)
	if (policy === 'profile') {
		// A person's public profile stays a public page, even for that person.
		return org && !org.personal && navigation
			? { ...navigation, orgSlug: username }
			: null
	}
	if (!org && session.username !== username) return null
	return {
		rail: 'workspace' as const,
		item: 'repositories' as const,
		orgSlug: username,
		workspaceSwitch: { section: 'repositories' as const },
	}
}
