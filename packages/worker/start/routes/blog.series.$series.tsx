/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadBlogSeries } from '#start/server/blog'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { documentHead } from '../components/document-head.ts'
import { BlogSeriesRoute } from '../pages/blog-series.tsx'

const pageQuery = createPageQuery('loadBlogSeries', loadBlogSeries, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/blog/series/$series')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	// Blog content is build-backed and does not depend on search parameters.
	context: ({ params }) => ({
		pageQueryInput: { series: params.series },
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: BlogSeries,
	notFoundComponent: NotFoundPage,
})
function BlogSeries() {
	return <BlogSeriesRoute data={usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
