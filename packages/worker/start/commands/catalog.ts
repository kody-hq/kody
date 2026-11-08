import {
	accountRailGroups,
	workspaceRailGroups,
	workspaceHomeHref,
} from '#client/routes/account-rail.ts'
import type { SessionInfo } from '#client/session.ts'
import { docsNav, docHref } from '#universal/docs-nav.ts'
import { routes } from '#universal/routes.ts'
import type { Command } from './model.ts'

export function commandCatalog(
	session: SessionInfo | null,
	slug: string | undefined,
	pathname: string,
): Command[] {
	const commands: Command[] = [
		['Documentation', '/docs', 'help guides'],
		['Community', '/community', 'discover packages install'],
		['Pricing', '/pricing', 'plans'],
		['Blog', '/blog', 'news'],
	].map(([title, href, keywords]) => ({
		id: href!,
		title: title!,
		href: href!,
		keywords,
		kind: 'page' as const,
		icon: 'book' as const,
	}))
	for (const section of docsNav) {
		if (section.adminOnly && !session?.roles.includes('admin')) continue
		for (const item of section.items)
			commands.push({
				id: `guide:${item.slug}`,
				title: item.label,
				subtitle: `Docs · ${section.label}`,
				keywords: item.slug,
				href: docHref(item.slug),
				kind: 'guide',
				icon: 'book',
			})
	}
	if (!session) return commands
	const org = session.organizations?.find((org) => org.slug === slug)
	const groups = [
		...accountRailGroups(),
		...(org
			? workspaceRailGroups({
					orgSlug: org.slug,
					personal: org.personal,
					role: org.role,
					profileUsername: session.username,
					executionContexts: session.featureFlags['execution-contexts'],
					profiles: session.featureFlags.profiles,
				})
			: []),
	]
	for (const group of groups)
		for (const item of group.items) {
			commands.push({
				id: item.href,
				title: item.label,
				subtitle: item.href.startsWith('/@') ? `@${slug}` : 'Your account',
				keywords: item.description,
				href: item.href,
				kind: 'page',
				icon: item.icon,
				context:
					pathname === item.href ||
					(item.id !== 'public-profile' &&
						pathname.startsWith(`${item.href}/`)),
			})
			for (const tab of item.tabs ?? [])
				if (tab.href !== item.href)
					commands.push({
						id: tab.href,
						title: tab.label,
						subtitle: `@${slug}`,
						href: tab.href,
						kind: 'page',
						icon: item.icon,
					})
		}
	for (const workspace of session.organizations ?? [])
		commands.push({
			id: `workspace:${workspace.slug}`,
			title: workspace.displayName || workspace.slug,
			subtitle: `Switch to @${workspace.slug}`,
			keywords: 'switch workspace organization account',
			href: workspaceHomeHref(workspace),
			kind: 'workspace',
			icon: 'users',
		})
	commands.push({
		id: 'new-org',
		title: 'Create organization',
		href: '/account/organizations/new',
		kind: 'action',
		icon: 'plus',
	})
	if (org?.role === 'owner' || org?.role === 'admin' || org?.role === 'member')
		commands.push(
			{
				id: `new-repo:${slug}`,
				title: 'Create repository',
				subtitle: `@${slug}`,
				keywords: 'new package code',
				href: routes.orgRepositoryNew.href({ orgSlug: org.slug }),
				kind: 'action',
				icon: 'plus',
				context: pathname.includes('/repositories'),
			},
			{
				id: `new-credential:${slug}`,
				title: 'Add credential',
				subtitle: `@${slug}`,
				keywords: 'new secret key oauth mcp connection',
				href: routes.orgCredentialNew.href({ orgSlug: org.slug }),
				kind: 'action',
				icon: 'key',
				context: pathname.includes('/credentials'),
			},
		)
	if (session.roles.includes('admin'))
		commands.push({
			id: 'admin',
			title: 'Admin',
			href: '/admin/users',
			kind: 'page',
			icon: 'shield',
		})
	return [...new Map(commands.map((command) => [command.id, command])).values()]
}
