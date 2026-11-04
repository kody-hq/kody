/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadBlogCategory } from '#start/server/blog'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { documentHead } from '../components/document-head.ts'
import { BlogCategoryRoute } from '../pages/blog-category.tsx'

const pageQuery = createPageQuery('loadBlogCategory', loadBlogCategory, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/blog/category/$category')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	// Blog content is build-backed and does not depend on search parameters.
	context: ({ params }) => ({
		pageQueryInput: { category: params.category },
	}),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: BlogCategory,
	notFoundComponent: NotFoundPage,
})
function BlogCategory() {
	return <BlogCategoryRoute data={usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
