/** @jsxImportSource @emotion/react */
import { adminPageNumber } from '../admin-read-input.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminSystemEmailPage } from '../pages/admin-system-email.tsx'
import { loadAdminSystemEmail } from '#start/server/admin-system-email'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminSystemEmail',
	loadAdminSystemEmail,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/system-email')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'system-email' },
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
				25,
				100,
			),
			messageId: new URLSearchParams(location.searchStr).get('messageId'),
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: SystemEmailPage,
})
function SystemEmailPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminSystemEmailPage payload={data.payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
