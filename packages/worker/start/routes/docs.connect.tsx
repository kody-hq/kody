/** @jsxImportSource @emotion/react */
import { docsConnectMarkdown } from '#start/server/markdown'
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { negotiatedDocument } from '../document-negotiation.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadDocsConnect } from '#start/server/docs'
import { DocsConnectRoute } from '../pages/docs-connect.tsx'
import { documentHead } from '../components/document-head.ts'

const pageQuery = createPageQuery('loadDocsConnect', loadDocsConnect, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/docs/connect')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		motionGroup: 'docs',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	server: {
		middleware: [negotiatedDocument],
		handlers: { GET: docsConnectMarkdown },
	},
	context: () => ({ pageQueryInput: undefined }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: DocsConnect,
})
function DocsConnect() {
	return <DocsConnectRoute {...usePageData()} />
}

function usePageData() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	return usePageQuery(pageQuery(actorKey, pageQueryInput)).data
}
