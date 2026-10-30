/** @jsxImportSource @emotion/react */
import {
	createPageQuery,
	loadPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AdminOrgsPage } from '../pages/admin-orgs.tsx'
import { loadAdminOrgs } from '#start/server/admin-orgs'
import {
	adminOrgReturnTo,
	adminOrgsFilters,
	adminOrgsSearch,
} from '../admin-orgs-input.ts'
import { documentHead } from '../components/document-head.ts'

const pageQuery = createPageQuery('loadAdminOrgs', loadAdminOrgs, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/admin/orgs')({
	staticData: {
		filterSearchKeys: ['q', 'status', 'kind', 'page'],
		navigation: { rail: 'admin', item: 'orgs' },
	},
	validateSearch: adminOrgsSearch,
	search: {
		middlewares: [stripSearchParams({ status: 'live', kind: 'all', page: 1 })],
	},
	loaderDeps: ({ search }) => ({
		query: search.q,
		status: search.status,
		kind: search.kind,
		page: search.page,
	}),
	beforeLoad: ({ location, search, context }) => {
		const filters = adminOrgsFilters(search)
		const pageQueryInput = {
			...filters,
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
	component: OrgsPage,
})

function OrgsPage() {
	const data = usePageData()
	const { pageLocation, pageQueryInput } = Route.useRouteContext()
	if (!data) return null
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminOrgsPage
			payload={{ ...data.payload, items: data.payload.items }}
			currentHref={pageLocation.href}
			status={pageQueryInput.status}
			kind={pageQueryInput.kind}
			query={pageQueryInput.query}
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
