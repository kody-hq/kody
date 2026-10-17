/** @jsxImportSource @emotion/react */
import { blogMarkdown } from '#start/server/markdown'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { NotFoundPage } from '../components/not-found-page.tsx'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadBlogPost } from '#start/server/blog'
import { documentHead } from '../components/document-head.ts'
import { BlogPostRoute } from '../pages/blog-post.tsx'

const pageQuery = createPageQuery('loadBlogPost', loadBlogPost, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/blog/$slug')({
	staticData: { shell: { gutters: 'page' }, sessionVerification: 'public' },
	server: { middleware: [negotiatedDocument], handlers: { GET: blogMarkdown } },
	// Blog content is build-backed and does not depend on search parameters.
	context: ({ params }) => ({ pageQueryInput: { slug: params.slug } }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: BlogPost,
	notFoundComponent: NotFoundPage,
})
function BlogPost() {
	return <BlogPostRoute post={usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
