/** @jsxImportSource @emotion/react */
import {
	loadPageQuery,
	createPageQuery,
	useFilteredPageQuery,
} from '../page-query.ts'
import { communityReadInput } from '../public-read-input.ts'
import { createFileRoute } from '@tanstack/react-router'
import { CommunityRoute } from '../pages/community.tsx'
import { documentHead } from '../components/document-head.ts'
import { loadCommunity } from '#start/server/public-data'

const pageQuery = createPageQuery('loadCommunity', loadCommunity)

export const Route = createFileRoute('/community')({
	staticData: {
		filterSearchKeys: ['q', 'sort', 'category', 'limit', 'org'],
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	// beforeLoad reruns on every navigation. Route `context` is cached per
	// match, and search-only filter changes keep the same match, so a
	// `context` read would keep the first query input after a search submit.
	beforeLoad: ({ location, context }) => {
		const pageQueryInput = communityReadInput(location.searchStr)
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
	component: Community,
})
function Community() {
	const data = usePageData()
	return data ? <CommunityRoute data={data.data} /> : null
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return useFilteredPageQuery(pageQuery(actorKey, pageQueryInput), [
		actorKey,
		'community',
	]).data
}
