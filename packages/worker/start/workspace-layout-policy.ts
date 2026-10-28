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
		// Workspaces the viewer belongs to (their own profile included) keep
		// the workspace rail with Public profile selected. Everyone else's
		// profile stays a plain public page.
		if (!navigation) return null
		if (org) return { ...navigation, orgSlug: username }
		// A legacy rename can leave the username apart from the personal org
		// slug; the rail then falls back to the personal org.
		return session.username === username
			? { ...navigation, orgSlug: null }
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
