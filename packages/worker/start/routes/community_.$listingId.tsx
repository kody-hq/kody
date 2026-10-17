/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { createFileRoute } from '@tanstack/react-router'
import { loadPackage } from '#start/server/public-data'
import { CommunityDetailRoute } from '../pages/community-detail.tsx'
import { renderMissingListing } from '../components/community-detail-sections.tsx'
import { documentHead } from '../components/document-head.ts'

const pageQuery = createPageQuery('loadPackage', loadPackage, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/community_/$listingId')({
	staticData: {
		anonymousDocumentCache: 'visibility',
		shell: { gutters: 'page' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			username: '',
			kodyId: '',
			listingId: params.listingId,
			search: location.searchStr,
		},
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Package,
	notFoundComponent: NotFoundPage,
})
function Package() {
	const result = usePageData()
	return result.kind === 'page' ? (
		<CommunityDetailRoute
			key={`${result.data.username}/${result.data.kodyId}`}
			{...result}
		/>
	) : (
		renderMissingListing(
			'Unauthorized',
			'You are not allowed to view this page.',
		)
	)
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
