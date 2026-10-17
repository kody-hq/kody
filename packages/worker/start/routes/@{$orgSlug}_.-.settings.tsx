/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadOrgSettings } from '#start/server/org-management'
import { OrgSettingsPage } from '../pages/org-management.tsx'
const pageQuery = createPageQuery('loadOrgSettings', loadOrgSettings, {
	freshAuthorization: true,
})
export const Route = createFileRoute('/@{$orgSlug}_/-/settings')({
	staticData: {
		workspaceSwitch: { section: 'settings' },
		navigation: { rail: 'workspace', item: 'settings' },
		orgScope: {},
		shell: { gutters: 'page' },
	},
	loader: ({ context, params, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, { slug: params.orgSlug }),
			preload,
		),
	head: () => ({ meta: [{ title: 'Settings' }] }),
	component: Page,
})
function Page() {
	const { actorKey } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const query = pageQuery(actorKey, { slug: orgSlug })
	const { data } = usePageQuery(query)
	return <OrgSettingsPage key={orgSlug} data={data} queryKey={query.queryKey} />
}
