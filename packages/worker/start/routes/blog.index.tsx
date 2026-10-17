/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadBlog } from '#start/server/blog'
import { documentHead } from '../components/document-head.ts'
import { BlogRoute } from '../pages/blog.tsx'

const pageQuery = createPageQuery('loadBlog', loadBlog, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/blog/')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	// Blog content is build-backed and does not depend on search parameters.
	context: () => ({ pageQueryInput: undefined }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Blog,
})
function Blog() {
	return <BlogRoute data={usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
