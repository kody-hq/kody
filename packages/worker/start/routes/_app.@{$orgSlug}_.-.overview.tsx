/** @jsxImportSource @emotion/react */
import { createFileRoute } from '@tanstack/react-router'
import { loadOrgOverview } from '#start/server/org-management'
import { WorkspaceOverview } from '../pages/workspace-overview.tsx'
export const Route = createFileRoute('/_app/@{$orgSlug}_/-/overview')({
	staticData: {
		navigation: { rail: 'workspace', item: 'overview' },
		orgScope: {},
	},
	loader: ({ params }) => loadOrgOverview({ data: { slug: params.orgSlug } }),
	component: Page,
	head: () => ({ meta: [{ title: 'Overview' }] }),
})
function Page() {
	return <WorkspaceOverview data={Route.useLoaderData()} />
}
