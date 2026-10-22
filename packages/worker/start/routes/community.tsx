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
		filterSearchKeys: ['q', 'sort', 'category', 'limit'],
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => search,
	context: ({ location, context }) => {
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
