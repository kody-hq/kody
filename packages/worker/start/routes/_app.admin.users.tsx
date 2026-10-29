/** @jsxImportSource @emotion/react */
import {
	loadPageQuery,
	createPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AdminUsersPage } from '../pages/admin-users.tsx'
import { loadAdminUsers } from '#start/server/admin-users'
import {
	adminUsersFilters,
	adminUsersSelection,
	adminUsersSearch,
} from '../admin-users-input.ts'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadAdminUsers', loadAdminUsers, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/admin/users')({
	staticData: {
		filterSearchKeys: ['q', 'role', 'verification', 'status', 'pageSize'],
		navigation: { rail: 'admin', item: 'users' },
	},
	validateSearch: adminUsersSearch,
	search: {
		middlewares: [stripSearchParams({ pageSize: 20, status: 'live' })],
	},
	loaderDeps: ({ search }) => ({
		selected: search.selected,
	}),
	beforeLoad: ({ location, search, context }) => {
		const pageQueryInput = {
			...adminUsersFilters(search),
			selectedStableUserId: adminUsersSelection(search),
			detail: false,
			returnTo: location.pathname,
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
	component: UsersPage,
})
function UsersPage() {
	const data = usePageData()
	const { pageLocation: location, pageQueryInput } = Route.useRouteContext()
	if (!data) return null
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminUsersPage
			payload={data.payload}
			currentHref={location.href}
			selectedStableUserId={pageQueryInput.selectedStableUserId}
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
