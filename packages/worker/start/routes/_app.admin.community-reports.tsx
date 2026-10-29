/** @jsxImportSource @emotion/react */
import {
	loadPageQuery,
	createPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminCommunityReportsPage } from '../pages/admin-community-reports.tsx'
import { loadAdminCommunityReports } from '#start/server/admin-community-reports'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminCommunityReports',
	loadAdminCommunityReports,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/admin/community-reports')({
	staticData: {
		filterSearchKeys: ['status'],
		navigation: { rail: 'admin', item: 'community-reports' },
	},
	beforeLoad: ({ location, context }) => {
		const pageQueryInput = {
			returnTo: location.pathname,
			status: new URLSearchParams(location.searchStr).get('status'),
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
	component: CommunityReportsPage,
})
function CommunityReportsPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	if (!data) return null
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminCommunityReportsPage
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
