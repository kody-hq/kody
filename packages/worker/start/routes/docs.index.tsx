/** @jsxImportSource @emotion/react */
import { docsMarkdown } from '#start/server/markdown'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { docsIntroSlug } from '#universal/docs-nav.ts'
import { DocDetailRoute } from '../pages/doc-detail.tsx'
import { documentHead } from '../components/document-head.ts'
import { loadDoc } from '#start/server/docs'

const pageQuery = createPageQuery('loadDoc', loadDoc, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/docs/')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		motionGroup: 'docs',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	server: { middleware: [negotiatedDocument], handlers: { GET: docsMarkdown } },
	context: () => ({ pageQueryInput: { slug: docsIntroSlug } }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Doc,
})
function Doc() {
	return <DocDetailRoute {...usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
