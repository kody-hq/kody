/** @jsxImportSource @emotion/react */
import { searchText, textSearch } from '../filter-search.ts'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { AdminStarterTemplatesPage } from '../pages/admin-starter-templates.tsx'
import { loadAdminStarterTemplates } from '#start/server/admin-starter-templates'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadAdminStarterTemplates',
	loadAdminStarterTemplates,
	{ freshAuthorization: true },
)

export const Route = createFileRoute('/_app/admin/starter-templates_/new')({
	staticData: {
		presentationSearchKeys: ['q'],
		navigation: { rail: 'admin', item: 'starter-templates' },
	},
	validateSearch: (search: Record<string, unknown>) => ({
		...textSearch(search),
		package: searchText(search['package']),
	}),
	context: ({ location }) => ({
		pageQueryInput: {
			returnTo: location.pathname,
			view: 'new' as const,
			candidatePackage:
				searchText((location.search as Record<string, unknown>)['package']) ||
				undefined,
		},
	}),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: StarterTemplatesPage,
})
function StarterTemplatesPage() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const data = usePageQuery(pageQuery(actorKey, pageQueryInput)).data
	return data.forbidden ? (
		<p>Forbidden</p>
	) : (
		<AdminStarterTemplatesPage
			payload={data.payload}
			selection={{ selectedId: null, isCreating: true }}
			currentHref={pageLocation.href}
		/>
	)
}
