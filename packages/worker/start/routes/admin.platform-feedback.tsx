/** @jsxImportSource @emotion/react */
import { adminPageNumber } from '../admin-read-input.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminPlatformFeedbackPage } from '../pages/admin-platform-feedback.tsx'
import { loadAdminPlatformFeedback } from '#start/server/admin-platform-feedback'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminPlatformFeedback',
	loadAdminPlatformFeedback,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/platform-feedback')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'platform-feedback' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location }) => ({
		pageQueryInput: {
			returnTo: location.pathname + location.searchStr,
			page: adminPageNumber(
				new URLSearchParams(location.searchStr).get('page'),
				1,
			),
			pageSize: adminPageNumber(
				new URLSearchParams(location.searchStr).get('pageSize'),
				20,
				100,
			),
			status: new URLSearchParams(location.searchStr).get('status'),
			category: new URLSearchParams(location.searchStr).get('category'),
			feedbackId: new URLSearchParams(location.searchStr).get('feedbackId'),
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: PlatformFeedbackPage,
})
function PlatformFeedbackPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminPlatformFeedbackPage
			payload={data.payload}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
