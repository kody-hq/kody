/** @jsxImportSource @emotion/react */
import {
	createPageQuery,
	loadPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminOrgDetailPage } from '../pages/admin-orgs.tsx'
import { loadAdminOrg } from '#start/server/admin-orgs'
import { adminOrgReturnTo } from '../admin-orgs-input.ts'
import { documentHead } from '../components/document-head.ts'

const pageQuery = createPageQuery('loadAdminOrg', loadAdminOrg, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/admin/orgs_/$orgSlug')({
	staticData: { navigation: { rail: 'admin', item: 'orgs' } },
	beforeLoad: ({ location, params, context }) => {
		const pageQueryInput = {
			slug: params.orgSlug,
			returnTo: adminOrgReturnTo(location),
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
	component: OrgPage,
})

function OrgPage() {
	const data = usePageData()
	const { pageLocation } = Route.useRouteContext()
	if (!data) return null
	if (data.forbidden) return <p>Forbidden</p>
	if (!data.payload) return <p>Organization not found.</p>
	return (
		<AdminOrgDetailPage
			payload={data.payload}
			currentHref={pageLocation.href}
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
