/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgMembers } from '#start/server/org-management'
import { OrgMembersPage } from '../pages/org-management.tsx'
const pageQuery = createPageQuery('loadOrgMembers', loadOrgMembers, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/members')({
	staticData: {
		workspaceSwitch: { section: 'members' },
		navigation: { rail: 'workspace', item: 'members' },
		orgScope: {},
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { slug: params.orgSlug }),
			preload,
		),
	head: () => ({ meta: [{ title: 'Members' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug })
	const { data } = usePageQuery(query)
	return <OrgMembersPage data={data} queryKey={query.queryKey} />
}
