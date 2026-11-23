/** @jsxImportSource @emotion/react */
import { textSearch } from '../filter-search.ts'
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

export const Route = createFileRoute('/_app/admin/starter-templates')({
	staticData: {
		presentationSearchKeys: ['q'],
		navigation: { rail: 'admin', item: 'starter-templates' },
	},
	validateSearch: textSearch,
	context: ({ location }) => ({
		pageQueryInput: { returnTo: location.pathname, view: 'list' as const },
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
			selection={{ selectedId: null, isCreating: false }}
			currentHref={pageLocation.href}
		/>
	)
}
