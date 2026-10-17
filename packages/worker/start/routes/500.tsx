/** @jsxImportSource @emotion/react */
import { loadPageQuery, createPageQuery, usePageQuery } from '../page-query.ts'
import { createFileRoute } from '@tanstack/react-router'
import { loadInternalErrorPage } from '#start/server/error-page'
import { InternalErrorPage } from '../components/internal-error-page.tsx'
import { documentHead } from '../components/document-head.ts'
const pageQuery = createPageQuery(
	'loadInternalErrorPage',
	loadInternalErrorPage,
)

export const Route = createFileRoute('/500')({
	staticData: { shell: { gutters: 'page' } },
	context: () => ({ pageQueryInput: undefined }),
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
	return <InternalErrorPage />
}
