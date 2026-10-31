/** @jsxImportSource @emotion/react */
import { adminPageNumber } from '../admin-read-input.ts'
import {
	loadPageQuery,
	createPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminPlatformFeedbackPage } from '../pages/admin-platform-feedback.tsx'
import { loadAdminPlatformFeedback } from '#start/server/admin-platform-feedback'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminPlatformFeedback',
	loadAdminPlatformFeedback,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/admin/platform-feedback')({
	staticData: {
		filterSearchKeys: ['page', 'pageSize', 'status', 'category'],
		navigation: { rail: 'admin', item: 'platform-feedback' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	loaderDeps: ({ search }) => ({
		feedbackId: search.feedbackId,
	}),
	beforeLoad: ({ location, context }) => {
		const pageQueryInput = {
			returnTo: location.pathname,
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
		}
		return {
			pageQueryInput,
			pageHeadQueryKey: [
				...pageQuery(context.actorKey, pageQueryInput).queryKey,
			],
		}
	},
	shouldReload: ({ context }) => !context.inPlaceNavigation,
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
	if (!data) return null
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
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	return useFilteredPageQuery(pageQuery(actorKey, pageQueryInput), [
		actorKey,
		pageLocation.pathname,
	]).data
}
