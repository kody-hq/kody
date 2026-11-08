/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgSubjectAccess } from '#start/server/org-management'
import { OrgSubjectAccessPage } from '../pages/org-subject-access.tsx'
const pageQuery = createPageQuery(
	'loadOrgSubjectAccess',
	loadOrgSubjectAccess,
	{
		freshAuthorization: true,
	},
)
export const Route = createFileRoute(
	'/_app/@{$orgSlug}_/-/grants_/user/$userId',
)({
	staticData: {
		workspaceSwitch: { section: 'grants' },
		navigation: { rail: 'workspace', item: 'grants' },
		orgScope: {},
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, {
				slug: params.orgSlug,
				userId: params.userId,
			}),
			preload,
		),
	head: () => ({ meta: [{ title: 'Access' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug, userId } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug, userId })
	const { data } = usePageQuery(query)
	return <OrgSubjectAccessPage data={data} queryKey={query.queryKey} />
}
