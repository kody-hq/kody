/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminInsightsRoute } from '../pages/admin-insights.tsx'
import { loadAdminInsights } from '#start/server/admin-insights'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadAdminInsights', loadAdminInsights, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/admin/insights')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'insights' },
	},
	context: () => ({ pageQueryInput: undefined }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})
function Page() {
	const data = usePageData()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminInsightsRoute data={data.payload} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
