/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminSessionInsightsRoute } from '../pages/admin-session-insights.tsx'
import { loadAdminSessionInsights } from '#start/server/admin-session-insights'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminSessionInsights',
	loadAdminSessionInsights,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/admin/insights_/sessions')({
	staticData: {
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
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	const query = pageQuery(actorKey, pageQueryInput)
	const { data } = usePageQuery(query)
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminSessionInsightsRoute data={data.payload} queryKey={query.queryKey} />
	)
}
