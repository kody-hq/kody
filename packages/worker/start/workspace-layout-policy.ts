import type { SessionInfo } from '#client/session.ts'
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

function workspaceLayoutPolicy(matches: readonly LayoutMatch[]) {
	return matches.findLast((match) => match.staticData.workspaceLayout)
		?.staticData.workspaceLayout
}

function workspaceHandle(matches: readonly LayoutMatch[]) {
	const params = matches.at(-1)?.params
	if (!params || typeof params !== 'object' || !('username' in params))
		return null
	return typeof params.username === 'string' ? params.username : null
}

/** Profile and repository pages evaluate shell flags in their workspace. */
export function workspaceShellOrgSlug(matches: readonly LayoutMatch[]) {
	const policy = workspaceLayoutPolicy(matches)
	return policy === 'profile' || policy === 'resource'
		? workspaceHandle(matches)
		: null
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
	const policy = workspaceLayoutPolicy(matches)
	if (!policy) return null
	const navigation = pageNavigationForMatches(matches)
	if (policy === 'private') return navigation ?? null
	const username = workspaceHandle(matches)
	if (!username) return null
	const org = session.organizations?.find((entry) => entry.slug === username)
	if (policy === 'profile') {
		// Workspaces the viewer belongs to (their own profile included) keep
		// the workspace rail with Public profile selected. Everyone else's
		// profile stays a plain public page.
		if (!navigation) return null
		if (org) return { ...navigation, orgSlug: username }
		// A legacy rename can leave the username apart from the personal org
		// slug; the rail then falls back to the personal org.
		// Permanent: saved MCP client configs keep pointing at legacy app hosts, so those hosts keep serving.
		return session.username === username
			? { ...navigation, orgSlug: null }
			: null
	}
	if (!org && session.username !== username) return null
	return {
		rail: 'workspace' as const,
		item: 'repositories' as const,
		orgSlug: org?.slug ?? null,
		workspaceSwitch: { section: 'repositories' as const },
	}
}
