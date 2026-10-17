/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminRolesPage } from '../pages/admin-roles.tsx'
import { loadAdminRoles } from '#start/server/admin-roles'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadAdminRoles', loadAdminRoles, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/admin/roles')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'roles' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location }) => ({
		pageQueryInput: { returnTo: location.pathname + location.searchStr },
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: RolesPage,
})
function RolesPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminRolesPage payload={data.payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
