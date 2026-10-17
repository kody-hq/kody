/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgRepositories } from '#start/server/org-management'
import {
	AccountManagementShell,
	AccountPageHeader,
} from '../pages/account-management-components.tsx'
import { ProfileRoute } from '../pages/profile.tsx'
const pageQuery = createPageQuery('loadOrgRepositories', loadOrgRepositories, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/repositories')({
	staticData: {
		motionGroup: 'profile',
		workspaceSwitch: { section: 'repositories' },
		navigation: { rail: 'workspace', item: 'repositories' },
		orgScope: { section: 'repositories' },
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => ({
		limit: search.limit,
		q: search.limit != null ? search.q : undefined,
	}),
	context: ({ params, location }) => ({
		pageQueryInput: {
			slug: params.orgSlug,
			...repositoryInput(location.searchStr),
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: () => ({ meta: [{ title: 'Repositories' }] }),
	component: Page,
})
function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, pageQueryInput))
	const href = Route.useRouteContext().pageLocation.href
	return (
		<AccountManagementShell currentHref={href}>
			<AccountPageHeader
				title="Repositories"
				description="Every repository in this workspace, private ones included. Your public profile shows visitors the public ones."
				currentHref={href}
			/>
			<ProfileRoute
				data={data}
				currentHref={href}
				basePath={new URL(href, 'https://kody.local').pathname}
			/>
		</AccountManagementShell>
	)
}

function repositoryInput(search: string) {
	const params = new URLSearchParams(search)
	const parsed = Number.parseInt(params.get('limit') ?? '', 10)
	return {
		query: params.has('limit') ? (params.get('q') ?? '').trim() : '',
		limit:
			Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined,
	}
}
