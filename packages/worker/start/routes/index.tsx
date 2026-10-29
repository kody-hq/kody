/** @jsxImportSource @emotion/react */
import { homeMarkdown } from '#start/server/markdown'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadHome } from '#start/server/home'
import { HomeRoute } from '../pages/home.tsx'
import { homeDocumentHead } from '../components/home-document-head.ts'
import { documentHead } from '../components/document-head.ts'

const pageQuery = createPageQuery('loadHome', loadHome, { staleTime: 60_000 })

export const Route = createFileRoute('/')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	server: { middleware: [negotiatedDocument], handlers: { GET: homeMarkdown } },
	validateSearch: (search: Record<string, unknown>) => search,
	context: () => ({ pageQueryInput: undefined }),
	loader: async ({ context, preload }) => {
		const { head } = await loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		)
		// Static metadata belongs to the route, independent of background data refresh.
		return { head }
	},
	head: ({ loaderData, match }) =>
		documentHead(homeDocumentHead(loaderData?.head, match.search.og)),
	component: Home,
})

function Home() {
	const data = usePageData()
	return <HomeRoute {...data} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
