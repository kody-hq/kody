/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
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

export const Route = createFileRoute('/admin/users')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'users' },
	},
	validateSearch: adminUsersSearch,
	search: { middlewares: [stripSearchParams({ pageSize: 20 })] },
	loaderDeps: ({ search }) => search,
	beforeLoad: ({ location, search }) => ({
		pageQueryInput: {
			...adminUsersFilters(search),
			selectedStableUserId: adminUsersSelection(search),
			detail: false,
			returnTo: location.pathname + location.searchStr,
		},
	}),
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
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
