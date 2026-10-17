/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { CaseStudiesRoute } from '../pages/case-studies.tsx'

import { loadStaticPage } from '#start/server/static-page'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery('loadStaticPage', loadStaticPage, {
	staleTime: 5 * 60_000,
	gcTime: 30 * 60_000,
})

export const Route = createFileRoute('/case-studies')({
	staticData: {
		anonymousDocumentCache: 'marketing',
		shell: { gutters: 'page' },
		sessionVerification: 'public',
	},
	context: () => ({ pageQueryInput: '/case-studies' }),
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: ({ loaderData }) => documentHead(loaderData?.head),
	component: Page,
})

function Page() {
	const { actorKey, pageQueryInput } = Route.useRouteContext()
	usePageQuery(pageQuery(actorKey, pageQueryInput))
	return <CaseStudiesRoute />
}
