/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminProviderMarksRoute } from '../pages/admin-provider-marks.tsx'
import { loadAdminProviderMarks } from '#start/server/admin-provider-marks'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminProviderMarks',
	loadAdminProviderMarks,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/provider-marks')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'provider-marks' },
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
		<AdminProviderMarksRoute initialData={data.payload} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
