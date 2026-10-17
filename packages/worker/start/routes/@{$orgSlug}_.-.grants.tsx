/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgGrants } from '#start/server/org-management'
import { OrgGrantsPage } from '../pages/org-management.tsx'
const pageQuery = createPageQuery('loadOrgGrants', loadOrgGrants, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/grants')({
	staticData: {
		workspaceSwitch: { section: 'grants' },
		navigation: { rail: 'workspace', item: 'grants' },
		orgScope: {},
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { slug: params.orgSlug }),
			preload,
		),
	head: () => ({ meta: [{ title: 'Grants' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug })
	const { data } = usePageQuery(query)
	return <OrgGrantsPage data={data} queryKey={query.queryKey} />
}
