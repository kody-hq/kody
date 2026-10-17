/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminReservedUsernamesPage } from '../pages/admin-reserved-usernames.tsx'
import { loadAdminReservedUsernames } from '#start/server/admin-reserved-usernames'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminReservedUsernames',
	loadAdminReservedUsernames,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/reserved-usernames')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'reserved-usernames' },
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
	component: ReservedUsernamesPage,
})
function ReservedUsernamesPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminReservedUsernamesPage
			payload={data.payload}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
