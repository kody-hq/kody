/** @jsxImportSource @emotion/react */
import { textSearch } from '../filter-search.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminPlatformIntegrationsPage } from '../pages/admin-platform-integrations.tsx'
import { loadAdminPlatformIntegrations } from '#start/server/admin-platform-integrations'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminPlatformIntegrations',
	loadAdminPlatformIntegrations,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/admin/platform-integrations')({
	staticData: {
		motionGroup: 'admin',
		navigation: { rail: 'admin', item: 'platform-integrations' },
	},
	validateSearch: textSearch,
	loaderDeps: ({ search }) => search,
	context: ({ location }) => ({
		pageQueryInput: {
			returnTo: location.pathname + location.searchStr,
			view: 'list' as const,
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: PlatformIntegrationsPage,
})
function PlatformIntegrationsPage() {
	const data = usePageData()
	const { pageLocation: location } = Route.useRouteContext()
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminPlatformIntegrationsPage
			payload={data.payload}
			selection={{ selectedId: null, isCreating: false }}
			currentHref={location.href}
		/>
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
