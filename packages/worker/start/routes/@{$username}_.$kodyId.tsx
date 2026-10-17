/** @jsxImportSource @emotion/react */
import { PackageNoAccessPage } from '../components/package-no-access-page.tsx'
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

export const Route = createFileRoute('/@{$username}_/$kodyId')({
	staticData: {
		anonymousDocumentCache: 'visibility',
		motionGroup: 'package',
		shell: { gutters: 'page' },
	},
	loaderDeps: ({ search }) => search,
	context: ({ location, params }) => ({
		pageQueryInput: {
			...params,
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
	if (result.kind === 'no_access') return <PackageNoAccessPage {...result} />
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
