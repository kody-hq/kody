/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgCollaborators } from '#start/server/org-management'
import { OrgCollaboratorsPage } from '../pages/org-management.tsx'
const pageQuery = createPageQuery(
	'loadOrgCollaborators',
	loadOrgCollaborators,
	{ freshAuthorization: true },
)
export const Route = createFileRoute('/@{$orgSlug}_/-/collaborators')({
	staticData: {
		workspaceSwitch: { section: 'collaborators' },
		navigation: { rail: 'workspace', item: 'collaborators' },
		orgScope: {},
		shell: { gutters: 'page' },
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { slug: params.orgSlug }),
			preload,
		),
	head: () => ({ meta: [{ title: 'Collaborators' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug })
	const { data } = usePageQuery(query)
	return <OrgCollaboratorsPage data={data} queryKey={query.queryKey} />
}
