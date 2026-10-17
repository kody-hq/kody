/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgTeams } from '#start/server/org-management'
import { OrgTeamsPage } from '../pages/org-management.tsx'
const pageQuery = createPageQuery('loadOrgTeams', loadOrgTeams, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/teams')({
	staticData: {
		workspaceSwitch: { section: 'teams' },
		navigation: { rail: 'workspace', item: 'teams' },
		orgScope: {},
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { slug: params.orgSlug }),
			preload,
		),
	head: () => ({ meta: [{ title: 'Teams' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug })
	const { data } = usePageQuery(query)
	return <OrgTeamsPage data={data} queryKey={query.queryKey} />
}
