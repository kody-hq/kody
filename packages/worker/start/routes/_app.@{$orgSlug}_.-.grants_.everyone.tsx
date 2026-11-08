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
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/grants_/everyone')({
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
				subject: 'org',
			}),
			preload,
		),
	head: () => ({ meta: [{ title: 'Organization access' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, {
		slug: orgSlug,
		subject: 'org',
	})
	const { data } = usePageQuery(query)
	return <OrgSubjectAccessPage data={data} queryKey={query.queryKey} />
}
