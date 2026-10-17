/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminCodemodsPage } from '../pages/admin-codemods.tsx'
import { loadAdminCodemods } from '#start/server/admin-codemods'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadAdminCodemods', loadAdminCodemods, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/admin/codemods')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'codemods' },
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
	component: CodemodsPage,
})
function CodemodsPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminCodemodsPage payload={data.payload} currentHref={location.href} />
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
